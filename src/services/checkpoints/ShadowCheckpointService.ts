import fs from "fs/promises"
import os from "os"
import * as path from "path"
import crypto from "crypto"
import EventEmitter from "events"

import simpleGit, { SimpleGit } from "simple-git"
import pWaitFor from "p-wait-for"
import * as vscode from "vscode"

import { fileExistsAtPath } from "../../utils/fs"
import { executeRipgrep } from "../../services/search/file-search"
import { t } from "../../i18n"

import { CheckpointDiff, CheckpointResult, CheckpointEventMap } from "./types"
import { getExcludePatterns } from "./excludes"

export abstract class ShadowCheckpointService extends EventEmitter {
	public readonly taskId: string
	public readonly checkpointsDir: string
	public readonly workspaceDir: string

	protected _checkpoints: string[] = []
	protected _baseHash?: string

	protected readonly dotGitDir: string
	protected git?: SimpleGit
	protected readonly log: (message: string) => void
	protected shadowGitConfigWorktree?: string

	public get baseHash() {
		return this._baseHash
	}

	protected set baseHash(value: string | undefined) {
		this._baseHash = value
	}

	public get isInitialized() {
		return !!this.git
	}

	public getCheckpoints(): string[] {
		return this._checkpoints.slice()
	}

	constructor(taskId: string, checkpointsDir: string, workspaceDir: string, log: (message: string) => void) {
		super()

		const homedir = os.homedir()
		const desktopPath = path.join(homedir, "Desktop")
		const documentsPath = path.join(homedir, "Documents")
		const downloadsPath = path.join(homedir, "Downloads")
		const protectedPaths = [homedir, desktopPath, documentsPath, downloadsPath]

		if (protectedPaths.includes(workspaceDir)) {
			throw new Error(`Cannot use checkpoints in ${workspaceDir}`)
		}

		this.taskId = taskId
		this.checkpointsDir = checkpointsDir
		this.workspaceDir = workspaceDir

		this.dotGitDir = path.join(this.checkpointsDir, ".git")
		this.log = log
	}

	public async initShadowGit(onInit?: () => Promise<void>) {
		if (this.git) {
			throw new Error("Shadow git repo already initialized")
		}

		const nestedGitPath = await this.getNestedGitRepository()

		if (nestedGitPath) {
			// Show persistent error message with the offending path
			const relativePath = path.relative(this.workspaceDir, nestedGitPath)
			const message = t("common:errors.nested_git_repos_warning", { path: relativePath })
			vscode.window.showErrorMessage(message)

			throw new Error(
				`Checkpoints are disabled because a nested git repository was detected at: ${relativePath}. ` +
					"Please remove or relocate nested git repositories to use the checkpoints feature.",
			)
		}

		await fs.mkdir(this.checkpointsDir, { recursive: true })
		const git = simpleGit(this.checkpointsDir)
		const gitVersion = await git.version()
		this.log(`[${this.constructor.name}#create] git = ${gitVersion}`)

		let created = false
		const startTime = Date.now()

		if (await fileExistsAtPath(this.dotGitDir)) {
			this.log(`[${this.constructor.name}#initShadowGit] shadow git repo already exists at ${this.dotGitDir}`)
			const worktree = await this.getShadowGitConfigWorktree(git)

			if (worktree !== this.workspaceDir) {
				throw new Error(
					`Checkpoints can only be used in the original workspace: ${worktree} !== ${this.workspaceDir}`,
				)
			}

			await this.writeExcludeFile()
			this.baseHash = await git.revparse(["HEAD"])
		} else {
			this.log(`[${this.constructor.name}#initShadowGit] creating shadow git repo at ${this.checkpointsDir}`)
			await git.init()
			await git.addConfig("core.worktree", this.workspaceDir) // Sets the working tree to the current workspace.
			await git.addConfig("commit.gpgSign", "false") // Disable commit signing for shadow repo.
			await git.addConfig("user.name", "Costrict")
			await git.addConfig("user.email", "noreply@example.com")
			await this.writeExcludeFile()
			await this.stageAll(git)
			const { commit } = await git.commit("initial commit", { "--allow-empty": null })
			this.baseHash = commit
			created = true
		}

		const duration = Date.now() - startTime

		this.log(
			`[${this.constructor.name}#initShadowGit] initialized shadow repo with base commit ${this.baseHash} in ${duration}ms`,
		)

		this.git = git

		await onInit?.()

		this.emit("initialize", {
			type: "initialize",
			workspaceDir: this.workspaceDir,
			baseHash: this.baseHash,
			created,
			duration,
		})

		return { created, duration }
	}

	// Add basic excludes directly in git config, while respecting any
	// .gitignore in the workspace.
	// .git/info/exclude is local to the shadow git repo, so it's not
	// shared with the main repo - and won't conflict with user's
	// .gitignore.
	protected async writeExcludeFile() {
		const excludeFilePath = path.join(this.dotGitDir, "info", "exclude")

		try {
			// 确保目录存在
			await fs.mkdir(path.join(this.dotGitDir, "info"), { recursive: true })

			// 获取排除模式
			const patterns = await getExcludePatterns(this.workspaceDir)
			const content = patterns.join("\n")

			// 使用原子写入操作防止文件损坏
			const tempFilePath = `${excludeFilePath}.tmp`

			try {
				await fs.writeFile(tempFilePath, content, { encoding: "utf8" })
				await fs.rename(tempFilePath, excludeFilePath)
				this.log(`[${this.constructor.name}#writeExcludeFile] 成功写入排除文件: ${excludeFilePath}`)
			} catch (writeError) {
				// 清理临时文件
				try {
					await fs.unlink(tempFilePath)
				} catch {
					// 忽略清理错误
				}
				throw writeError
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			this.log(`[${this.constructor.name}#writeExcludeFile] 写入排除文件失败: ${errorMessage}`)
			throw new Error(`Failed to write exclude file: ${errorMessage}`)
		}
	}

	private async stageAll(git: SimpleGit) {
		const maxRetries = 3
		const retryDelay = 1000 // 1秒

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				await git.add(".")
				this.log(`[${this.constructor.name}#stageAll] 成功添加文件到 git (尝试 ${attempt}/${maxRetries})`)
				return
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				this.log(
					`[${this.constructor.name}#stageAll] 添加文件到 git 失败 (尝试 ${attempt}/${maxRetries}): ${errorMessage}`,
				)

				// 检查是否是文件锁定错误
				if (errorMessage.includes("index.lock") || errorMessage.includes("locked")) {
					if (attempt < maxRetries) {
						this.log(`[${this.constructor.name}#stageAll] 检测到文件锁定，等待 ${retryDelay}ms 后重试`)
						await new Promise((resolve) => setTimeout(resolve, retryDelay))
						continue
					}
				}

				// 最后一次尝试失败或非锁定错误
				if (attempt === maxRetries) {
					throw new Error(`Failed to stage files after ${maxRetries} attempts: ${errorMessage}`)
				}
			}
		}
	}

	private async getNestedGitRepository(): Promise<string | null> {
		try {
			// Find all .git/HEAD files that are not at the root level.
			const args = ["--files", "--hidden", "--follow", "-g", "**/.git/HEAD", this.workspaceDir]

			const gitPaths = await executeRipgrep({ args, workspacePath: this.workspaceDir })

			// Filter to only include nested git directories (not the root .git).
			// Since we're searching for HEAD files, we expect type to be "file"
			const nestedGitPaths = gitPaths.filter(({ type, path: filePath }) => {
				// Check if it's a file and is a nested .git/HEAD (not at root)
				if (type !== "file") return false

				// Ensure it's a .git/HEAD file and not the root one
				const normalizedPath = filePath.replace(/\\/g, "/")
				return (
					normalizedPath.includes(".git/HEAD") &&
					!normalizedPath.startsWith(".git/") &&
					normalizedPath !== ".git/HEAD"
				)
			})

			if (nestedGitPaths.length > 0) {
				// Get the first nested git repository path
				// Remove .git/HEAD from the path to get the repository directory
				const headPath = nestedGitPaths[0].path

				// Use path module to properly extract the repository directory
				// The HEAD file is at .git/HEAD, so we need to go up two directories
				const gitDir = path.dirname(headPath) // removes HEAD, gives us .git
				const repoDir = path.dirname(gitDir) // removes .git, gives us the repo directory

				const absolutePath = path.join(this.workspaceDir, repoDir)

				this.log(
					`[${this.constructor.name}#getNestedGitRepository] found ${nestedGitPaths.length} nested git repositories, first at: ${repoDir}`,
				)
				return absolutePath
			}

			return null
		} catch (error) {
			this.log(
				`[${this.constructor.name}#getNestedGitRepository] failed to check for nested git repos: ${error instanceof Error ? error.message : String(error)}`,
			)

			// If we can't check, assume there are no nested repos to avoid blocking the feature.
			return null
		}
	}

	private async getShadowGitConfigWorktree(git: SimpleGit) {
		if (!this.shadowGitConfigWorktree) {
			try {
				this.shadowGitConfigWorktree = (await git.getConfig("core.worktree")).value || undefined
			} catch (error) {
				this.log(
					`[${this.constructor.name}#getShadowGitConfigWorktree] failed to get core.worktree: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		return this.shadowGitConfigWorktree
	}

	public async saveCheckpoint(
		message: string,
		options?: { allowEmpty?: boolean; suppressMessage?: boolean },
	): Promise<CheckpointResult | undefined> {
		try {
			this.log(
				`[${this.constructor.name}#saveCheckpoint] starting checkpoint save (allowEmpty: ${options?.allowEmpty ?? false})`,
			)

			if (!this.git) {
				throw new Error("Shadow git repo not initialized")
			}

			const startTime = Date.now()
			await this.stageAll(this.git)
			const commitArgs = options?.allowEmpty ? { "--allow-empty": null } : undefined
			const result = await this.git.commit(message, commitArgs)
			const fromHash = this._checkpoints[this._checkpoints.length - 1] ?? this.baseHash!
			const toHash = result.commit || fromHash
			this._checkpoints.push(toHash)
			const duration = Date.now() - startTime

			if (result.commit) {
				this.emit("checkpoint", {
					type: "checkpoint",
					fromHash,
					toHash,
					duration,
					suppressMessage: options?.suppressMessage ?? false,
				})
			}

			if (result.commit) {
				this.log(
					`[${this.constructor.name}#saveCheckpoint] checkpoint saved in ${duration}ms -> ${result.commit}`,
				)
				return result
			} else {
				this.log(`[${this.constructor.name}#saveCheckpoint] found no changes to commit in ${duration}ms`)
				return undefined
			}
		} catch (e) {
			const error = e instanceof Error ? e : new Error(String(e))
			this.log(`[${this.constructor.name}#saveCheckpoint] failed to create checkpoint: ${error.message}`)
			this.emit("error", { type: "error", error })
			throw error
		}
	}

	public async restoreCheckpoint(commitHash: string) {
		const maxRetries = 3
		const retryDelay = 1000 // 1秒

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			try {
				this.log(`[${this.constructor.name}#restoreCheckpoint] 开始恢复检查点 (尝试 ${attempt}/${maxRetries})`)

				if (!this.git) {
					throw new Error("Shadow git repo not initialized")
				}

				const start = Date.now()

				// 使用重试机制处理可能的文件锁定问题
				try {
					await this.git.clean("f", ["-d", "-f"])
				} catch (cleanError) {
					const errorMessage = cleanError instanceof Error ? cleanError.message : String(cleanError)
					if (errorMessage.includes("index.lock") || errorMessage.includes("locked")) {
						if (attempt < maxRetries) {
							this.log(`[${this.constructor.name}#restoreCheckpoint] git clean 遇到锁定，等待重试`)
							await new Promise((resolve) => setTimeout(resolve, retryDelay))
							continue
						}
					}
					throw cleanError
				}

				try {
					await this.git.reset(["--hard", commitHash])
				} catch (resetError) {
					const errorMessage = resetError instanceof Error ? resetError.message : String(resetError)
					if (errorMessage.includes("index.lock") || errorMessage.includes("locked")) {
						if (attempt < maxRetries) {
							this.log(`[${this.constructor.name}#restoreCheckpoint] git reset 遇到锁定，等待重试`)
							await new Promise((resolve) => setTimeout(resolve, retryDelay))
							continue
						}
					}
					throw resetError
				}

				// Remove all checkpoints after the specified commitHash.
				const checkpointIndex = this._checkpoints.indexOf(commitHash)

				if (checkpointIndex !== -1) {
					this._checkpoints = this._checkpoints.slice(0, checkpointIndex + 1)
				}

				const duration = Date.now() - start
				this.emit("restore", { type: "restore", commitHash, duration })
				this.log(
					`[${this.constructor.name}#restoreCheckpoint] 成功恢复检查点 ${commitHash}，耗时 ${duration}ms (尝试 ${attempt}/${maxRetries})`,
				)
				return // 成功完成，退出重试循环
			} catch (e) {
				const error = e instanceof Error ? e : new Error(String(e))
				const errorMessage = error.message

				this.log(
					`[${this.constructor.name}#restoreCheckpoint] 恢复检查点失败 (尝试 ${attempt}/${maxRetries}): ${errorMessage}`,
				)

				// 如果是最后一次尝试，抛出错误
				if (attempt === maxRetries) {
					this.log(`[${this.constructor.name}#restoreCheckpoint] 所有重试尝试均失败，放弃恢复操作`)
					this.emit("error", { type: "error", error })
					throw new Error(`Failed to restore checkpoint after ${maxRetries} attempts: ${errorMessage}`)
				}

				// 等待后重试
				await new Promise((resolve) => setTimeout(resolve, retryDelay))
			}
		}
	}

	public async getDiff({ from, to }: { from?: string; to?: string }): Promise<CheckpointDiff[]> {
		if (!this.git) {
			throw new Error("Shadow git repo not initialized")
		}

		const result = []

		try {
			if (!from) {
				from = (await this.git.raw(["rev-list", "--max-parents=0", "HEAD"])).trim()
			}

			// Stage all changes so that untracked files appear in diff summary.
			await this.stageAll(this.git)

			this.log(`[${this.constructor.name}#getDiff] diffing ${to ? `${from}..${to}` : `${from}..HEAD`}`)
			const { files } = to ? await this.git.diffSummary([`${from}..${to}`]) : await this.git.diffSummary([from])

			const cwdPath = (await this.getShadowGitConfigWorktree(this.git)) || this.workspaceDir || ""

			for (const file of files) {
				const relPath = file.file
				const absPath = path.join(cwdPath, relPath)

				try {
					const before = await this.git.show([`${from}:${relPath}`]).catch(() => "")

					let after = ""
					if (to) {
						after = await this.git.show([`${to}:${relPath}`]).catch(() => "")
					} else {
						// 使用 try-finally 模式确保文件句柄正确关闭
						try {
							after = await fs.readFile(absPath, "utf8")
						} catch (readError) {
							// 文件可能已被删除或无法访问
							const errorMessage = readError instanceof Error ? readError.message : String(readError)
							this.log(`[${this.constructor.name}#getDiff] 无法读取文件 ${absPath}: ${errorMessage}`)
							after = ""
						}
					}

					result.push({ paths: { relative: relPath, absolute: absPath }, content: { before, after } })
				} catch (fileError) {
					const errorMessage = fileError instanceof Error ? fileError.message : String(fileError)
					this.log(`[${this.constructor.name}#getDiff] 处理文件 ${relPath} 时出错: ${errorMessage}`)
					// 继续处理其他文件，不让单个文件错误影响整个 diff 操作
					continue
				}
			}

			return result
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			this.log(`[${this.constructor.name}#getDiff] getDiff 操作失败: ${errorMessage}`)
			throw new Error(`Failed to get diff: ${errorMessage}`)
		}
	}

	/**
	 * 完整的资源清理方法
	 * 清理 SimpleGit 实例、EventEmitter 监听器、文件句柄和内部状态
	 */
	public async dispose(): Promise<void> {
		try {
			this.log(`[${this.constructor.name}#dispose] 开始清理 ShadowCheckpointService 资源`)

			// 1. 清理 SimpleGit 实例
			if (this.git) {
				try {
					// 确保没有正在进行的 Git 操作
					// SimpleGit 内部会处理进程清理，但我们需要确保引用被清除
					this.git = undefined
					this.log(`[${this.constructor.name}#dispose] SimpleGit 实例已清理`)
				} catch (error) {
					this.log(
						`[${this.constructor.name}#dispose] 清理 SimpleGit 实例时出错: ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			}

			// 2. 移除所有 EventEmitter 监听器
			try {
				this.removeAllListeners()
				this.log(`[${this.constructor.name}#dispose] EventEmitter 监听器已清理`)
			} catch (error) {
				this.log(
					`[${this.constructor.name}#dispose] 清理 EventEmitter 监听器时出错: ${error instanceof Error ? error.message : String(error)}`,
				)
			}

			// 3. 重置内部状态
			try {
				this._checkpoints = []
				this._baseHash = undefined
				this.shadowGitConfigWorktree = undefined
				this.log(`[${this.constructor.name}#dispose] 内部状态已重置`)
			} catch (error) {
				this.log(
					`[${this.constructor.name}#dispose] 重置内部状态时出错: ${error instanceof Error ? error.message : String(error)}`,
				)
			}

			this.log(`[${this.constructor.name}#dispose] ShadowCheckpointService 资源清理完成`)
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			this.log(`[${this.constructor.name}#dispose] 资源清理过程中发生错误: ${errorMessage}`)
			// 即使清理过程中出错，也要确保基本状态被重置
			this.git = undefined
			this._checkpoints = []
			this._baseHash = undefined
			this.shadowGitConfigWorktree = undefined
			throw error
		}
	}

	/**
	 * EventEmitter
	 */

	override emit<K extends keyof CheckpointEventMap>(event: K, data: CheckpointEventMap[K]) {
		return super.emit(event, data)
	}

	override on<K extends keyof CheckpointEventMap>(event: K, listener: (data: CheckpointEventMap[K]) => void) {
		return super.on(event, listener)
	}

	override off<K extends keyof CheckpointEventMap>(event: K, listener: (data: CheckpointEventMap[K]) => void) {
		return super.off(event, listener)
	}

	override once<K extends keyof CheckpointEventMap>(event: K, listener: (data: CheckpointEventMap[K]) => void) {
		return super.once(event, listener)
	}

	/**
	 * Storage
	 */

	public static hashWorkspaceDir(workspaceDir: string) {
		return crypto.createHash("sha256").update(workspaceDir).digest("hex").toString().slice(0, 8)
	}

	protected static taskRepoDir({ taskId, globalStorageDir }: { taskId: string; globalStorageDir: string }) {
		return path.join(globalStorageDir, "tasks", taskId, "checkpoints")
	}

	protected static workspaceRepoDir({
		globalStorageDir,
		workspaceDir,
	}: {
		globalStorageDir: string
		workspaceDir: string
	}) {
		return path.join(globalStorageDir, "checkpoints", this.hashWorkspaceDir(workspaceDir))
	}

	public static async deleteTask({
		taskId,
		globalStorageDir,
		workspaceDir,
	}: {
		taskId: string
		globalStorageDir: string
		workspaceDir: string
	}) {
		const workspaceRepoDir = this.workspaceRepoDir({ globalStorageDir, workspaceDir })
		const branchName = `roo-${taskId}`
		const git = simpleGit(workspaceRepoDir)
		const success = await this.deleteBranch(git, branchName)

		if (success) {
			console.log(`[${this.name}#deleteTask.${taskId}] deleted branch ${branchName}`)
		} else {
			console.error(`[${this.name}#deleteTask.${taskId}] failed to delete branch ${branchName}`)
		}
	}

	public static async deleteBranch(git: SimpleGit, branchName: string) {
		const branches = await git.branchLocal()

		if (!branches.all.includes(branchName)) {
			console.error(`[${this.constructor.name}#deleteBranch] branch ${branchName} does not exist`)
			return false
		}

		const currentBranch = await git.revparse(["--abbrev-ref", "HEAD"])

		if (currentBranch === branchName) {
			const worktree = await git.getConfig("core.worktree")

			try {
				await git.raw(["config", "--unset", "core.worktree"])
				await git.reset(["--hard"])
				await git.clean("f", ["-d"])
				const defaultBranch = branches.all.includes("main") ? "main" : "master"
				await git.checkout([defaultBranch, "--force"])

				await pWaitFor(
					async () => {
						const newBranch = await git.revparse(["--abbrev-ref", "HEAD"])
						return newBranch === defaultBranch
					},
					{ interval: 500, timeout: 2_000 },
				)

				await git.branch(["-D", branchName])
				return true
			} catch (error) {
				console.error(
					`[${this.constructor.name}#deleteBranch] failed to delete branch ${branchName}: ${error instanceof Error ? error.message : String(error)}`,
				)

				return false
			} finally {
				if (worktree.value) {
					await git.addConfig("core.worktree", worktree.value)
				}
			}
		} else {
			await git.branch(["-D", branchName])
			return true
		}
	}
}
