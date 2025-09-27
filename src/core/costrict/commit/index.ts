/**
 * Commit generation module for ZGSM
 *
 * Provides functionality to generate commit messages based on local changes
 * and populate them in VSCode's SCM input.
 */

export * from "./types"
export * from "./commitGenerator"
export * from "./commitService"

/**
 * Commit generation command handler
 */
export async function handleGenerateCommitMessage(
	provider: import("../../webview/ClineProvider").ClineProvider,
): Promise<void> {
	const { CommitService } = await import("./commitService")

	const workspaceRoot = CommitService.getWorkspaceRoot()
	if (!workspaceRoot) {
		throw new Error("No workspace folder found")
	}

	const isGitRepo = await CommitService.isGitRepository(workspaceRoot)
	if (!isGitRepo) {
		throw new Error("Current workspace is not a git repository")
	}

	const commitService = new CommitService()
	commitService.initialize(workspaceRoot, provider)

	await commitService.generateAndPopulateCommitMessage()
}
