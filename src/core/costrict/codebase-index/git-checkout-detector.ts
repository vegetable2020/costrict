import * as vscode from "vscode"
import * as path from "path"
import { EventEmitter } from "events"
import { simpleGit, SimpleGit } from "simple-git"
import { ILogger } from "../../../utils/logger"
import ZgsmCodebaseIndexManager from "."

// Optimized constant definitions
const CHECK_THROTTLE = 1000 // Throttle time: 1 second
const GIT_RETRY_COUNT = 3 // Git operation retry count
const GIT_RETRY_DELAY = 100 // Git operation retry delay (milliseconds)

export interface CheckoutEvent {
	oldBranch: string | undefined
	newBranch: string
}

export class GitCheckoutDetector extends EventEmitter {
	private git: SimpleGit
	private lastBranch: string | undefined
	// Throttle timer
	private lastEmit?: NodeJS.Timeout
	// Resource cleanup flag
	private isDisposed = false
	// File watcher reference (public property for external access)
	public watcher?: vscode.FileSystemWatcher
	// Logger instance
	private logger?: ILogger

	constructor(repoRoot: string, logger?: ILogger) {
		super()
		this.git = simpleGit(repoRoot)
		this.logger = logger
		this.init()
	}

	// /** Returns absolute path of .git/HEAD */
	// get headPath(): string {
	// 	return path.join(this.repoRoot, ".git", "HEAD")
	// }

	/** Initialize: read current branch */
	private async init(): Promise<void> {
		try {
			this.lastBranch = await this.currentBranch()
		} catch {
			/* ignore */
		}
	}

	/** Exposed externally: trigger 'checkout' event when checkout is detected */
	async onHeadChanged(): Promise<void> {
		// Check if resources have been disposed
		if (this.isDisposed) return

		// Clear previous timer (throttling mechanism)
		clearTimeout(this.lastEmit)

		this.lastEmit = setTimeout(async () => {
			if (this.isDisposed) return

			try {
				const newBranch = await this.currentBranch()
				const normalizedBranch = this.normalizeBranchName(newBranch)

				// Validation: must be a valid branch name
				if (!normalizedBranch) return

				const normalizedLastBranch = this.normalizeBranchName(this.lastBranch)
				if (normalizedBranch === normalizedLastBranch) return // Branch unchanged

				const event: CheckoutEvent = {
					oldBranch: normalizedLastBranch,
					newBranch: normalizedBranch,
				}
				this.lastBranch = normalizedBranch
				this.emit("checkout", event)
			} catch (error) {
				// Enhanced error handling: log error without interrupting program
				const message = `[GitCheckoutDetector] Failed to detect branch change: ${error instanceof Error ? error.message : String(error)}`
				if (this.logger) {
					this.logger.warn(message)
				} else {
					console.warn(message)
				}
			}
		}, CHECK_THROTTLE)
	}

	/**
	 * Normalize branch name processing
	 * @param branchRef Branch reference (e.g., refs/heads/main or commit hash)
	 * @returns Normalized branch name
	 */
	private normalizeBranchName(branchRef: string | undefined): string | undefined {
		if (!branchRef) return undefined

		// Remove refs/heads/ prefix
		if (branchRef.startsWith("refs/heads/")) {
			return branchRef.replace("refs/heads/", "")
		}

		// Return branch name or commit hash directly
		return branchRef
	}

	/**
	 * Git operation with retry mechanism
	 * @param operation Git operation function
	 * @param operationName Operation name (for error logging)
	 * @returns Operation result
	 */
	private async executeWithRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T | undefined> {
		let lastError: Error | undefined

		for (let attempt = 1; attempt <= GIT_RETRY_COUNT; attempt++) {
			try {
				return await operation()
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error))

				// If this is the last attempt, throw the error directly
				if (attempt === GIT_RETRY_COUNT) {
					const message = `[GitCheckoutDetector] ${operationName} failed after ${GIT_RETRY_COUNT} attempts: ${lastError.message}`
					if (this.logger) {
						this.logger.warn(message)
					} else {
						console.warn(message)
					}
					return undefined
				}

				await new Promise((resolve) => setTimeout(resolve, GIT_RETRY_DELAY * attempt))
			}
		}

		return undefined
	}

	/**
	 * Get current branch reference with more efficient commands and retry mechanism
	 * @returns Current branch reference or undefined (on failure)
	 */
	private async currentBranch(): Promise<string | undefined> {
		// Prefer using git branch --show-current (more efficient and direct)
		const getCurrentBranch = async () => {
			const result = await this.git.raw(["branch", "--show-current"])
			const branchName = result.trim()
			return branchName ? `refs/heads/${branchName}` : undefined
		}

		// Fallback: use symbolic-ref
		const getSymbolicRef = async () => {
			const ref = (await this.git.raw(["symbolic-ref", "HEAD"])).trim()
			return ref
		}

		// Handle detached HEAD state
		const getDetachedHead = async () => {
			const sha = (await this.git.revparse(["--short", "HEAD"])).trim()
			return sha
		}

		// Try to get current branch
		let branchRef = await this.executeWithRetry(getCurrentBranch, "get current branch")

		if (!branchRef) {
			// Fallback: try symbolic-ref
			branchRef = await this.executeWithRetry(getSymbolicRef, "get symbolic ref")
		}

		if (!branchRef) {
			// Last resort: handle detached HEAD state
			branchRef = await this.executeWithRetry(getDetachedHead, "get detached head")
		}

		return branchRef
	}

	/**
	 * Resource cleanup method
	 */
	dispose(): void {
		if (this.isDisposed) return

		this.isDisposed = true

		// Clean up timer
		if (this.lastEmit) {
			clearTimeout(this.lastEmit)
			this.lastEmit = undefined
		}

		// Clean up file watcher
		if (this.watcher) {
			this.watcher.dispose()
			this.watcher = undefined
		}

		// Remove all event listeners
		this.removeAllListeners()

		const message = "[GitCheckoutDetector] Resources disposed"
		if (this.logger) {
			this.logger.info(message)
		} else {
			console.log(message)
		}
	}
}

export function initGitCheckoutDetector(context: vscode.ExtensionContext, logger: ILogger) {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	if (!root) return

	// Create detector with logger
	const detector = new GitCheckoutDetector(root, logger)

	// Use VS Code's watcher to monitor .git/HEAD
	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, ".git/HEAD"))

	// Save watcher reference for cleanup
	detector.watcher = watcher

	// Add file watcher event handlers
	watcher.onDidCreate(() => {
		logger.debug("[GitCheckoutDetector] .git/HEAD file created")
		detector.onHeadChanged()
	})

	watcher.onDidChange(() => {
		logger.debug("[GitCheckoutDetector] .git/HEAD file changed")
		detector.onHeadChanged()
	})

	// Add file watcher error handling
	watcher.onDidDelete(() => {
		logger.warn("[GitCheckoutDetector] .git/HEAD file deleted - this may indicate a corrupted git repository")
		// Do not trigger branch switch event when file is deleted
	})

	// Show notification after receiving event
	detector?.on("checkout", async ({ oldBranch, newBranch }) => {
		try {
			const zgsmCodebaseIndexManager = ZgsmCodebaseIndexManager.getInstance()

			// Get workspace path
			const result = await zgsmCodebaseIndexManager.publishWorkspaceEvents({
				workspace: root,
				data: [
					{
						eventType: "open_workspace",
						eventTime: `${Date.now()}`,
						sourcePath: "",
						targetPath: "",
					},
				],
			})

			if (result.success) {
				vscode.window.showInformationMessage(`Branch switched: ${oldBranch ?? "(unknown)"} → ${newBranch}`)
				logger.info(`[GitCheckoutDetector:${oldBranch} -> ${newBranch}] Successfully open_workspace event`)
			} else {
				logger.error(
					`[GitCheckoutDetector:${oldBranch} -> ${newBranch}] Failed to open_workspace event: ${result.message}`,
				)
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error occurred while open_workspace event"
			logger.error(`[GitCheckoutDetector:${oldBranch} -> ${newBranch}] ${errorMessage}`)
		}
	})

	// Add cleanup logic for extension uninstallation
	const disposable = vscode.Disposable.from({
		dispose: () => {
			logger.debug("[GitCheckoutDetector] Disposing git checkout detector")
			detector.dispose()
		},
	})

	// Add both watcher and cleanup logic to subscription list
	context.subscriptions.push(watcher, disposable)

	logger.debug("[GitCheckoutDetector] Git checkout detector initialized")
}
