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
	const { t } = await import("../../../i18n")

	const workspaceRoot = CommitService.getWorkspaceRoot()
	if (!workspaceRoot) {
		throw new Error(t("commit:commit.error.noWorkspace"))
	}

	const isGitRepo = await CommitService.isGitRepository(workspaceRoot)
	if (!isGitRepo) {
		throw new Error(t("commit:commit.error.notGitRepo"))
	}

	const commitService = new CommitService()
	commitService.initialize(workspaceRoot, provider)

	await commitService.generateAndPopulateCommitMessage()
}
