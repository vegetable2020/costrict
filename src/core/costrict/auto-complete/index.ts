import * as vscode from "vscode"
import OpenAI from "openai"
import { Completion } from "openai/resources/completions"
import { v7 as uuidv7 } from "uuid"
import { COSTRICT_DEFAULT_HEADERS } from "../../../shared/headers"
import { ZgsmAuthConfig, ZgsmAuthStorage } from "../auth"
import { NOT_PROVIDERED } from "../base/common"
import type { ClineProvider } from "../../webview/ClineProvider"
import { getClientId } from "../../../utils/getClientId"
import { CompletionAcception, getDependencyImports, getHideScoreArgs } from "../completion"

const completionUrl = "/code-completion/api/v1"
export const settings = {
	// fillmodel in settings
	fillmodel: true,
	// openai_model in settings
	openai_model: "fastertransformer",
	// temperature in settings
	temperature: 0.1,
}
let client: OpenAI
let stopWords = [] as string[]
let parentId = ""
let acception = CompletionAcception.None
let fetching = false
let preAbortController: AbortController | null
let lastTimer = 0
export const autoCompleteHandler = async ({
	context,
	provider,
	outputChannel,
	lastChange,
}: {
	context: vscode.ExtensionContext
	provider: ClineProvider
	outputChannel: vscode.OutputChannel
	lastChange: any
}) => {
	const editor = vscode.window.activeTextEditor
	if (!editor) return
	if (fetching && preAbortController) {
		preAbortController?.abort?.()
		preAbortController = null
	}
	const now = Date.now()
	if (now - lastTimer < 500) {
		lastTimer = now
		return
	}

	lastTimer = now
	fetching = true
	preAbortController = new AbortController()

	if (!client) {
		client = new OpenAI({
			baseURL: "",
			apiKey: NOT_PROVIDERED, // 建议用环境变量
			defaultHeaders: {
				...COSTRICT_DEFAULT_HEADERS,
				// "X-Request-ID": uuidv7(),
			},
			timeout: 5000,
		})
		stopWords = vscode.workspace.getConfiguration("IntelligentCodeCompletion").get("inlineCompletion")
			? ["\n", "\r"]
			: []
	}
	const { apiConfiguration } = await provider.getState()
	const tokens = await ZgsmAuthStorage.getInstance().getTokens()
	const baseUrl = apiConfiguration.zgsmBaseUrl || ZgsmAuthConfig.getInstance().getDefaultApiBaseUrl()
	const apiKey = apiConfiguration.zgsmAccessToken || tokens?.access_token || NOT_PROVIDERED
	const document = editor.document
	const position = editor.selection.active
	const textBeforeCursor = document.getText(new vscode.Range(new vscode.Position(0, 0), position))

	client.baseURL = `${baseUrl}${completionUrl}`
	client.apiKey = apiKey

	vscode.window.setStatusBarMessage("🤖 正在生成补全...", 2000)

	// 调用 OpenAI API 获取补全
	// const completion = await client.completions.create({
	//   model: 'gpt-4.1-mini', // 或其他支持 code 模型
	//   input: [
	//     {
	//       role: 'user',
	//       content: `补全下面的代码片段：\n\n${textBeforeCursor}`
	//     }
	//   ],
	// })
	const client_id = getClientId()
	const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : ""
	const requestId = uuidv7()
	const headers = {
		...COSTRICT_DEFAULT_HEADERS,
		"X-Request-ID": requestId,
		"zgsm-client-id": client_id,
	}
	const filePath = editor.document.uri.fsPath
	const relativePath = vscode.workspace.asRelativePath(filePath)
	const documentContent = editor.document.getText()
	const importContent = getDependencyImports(relativePath, documentContent).join("\n")

	try {
		const completion = await client.completions.create(
			{
				// no use
				model: settings.openai_model,
				temperature: settings.temperature,
				stop: stopWords,
				prompt: null,
			},
			{
				// in use
				headers,
				signal: preAbortController.signal,
				body: {
					model: settings.openai_model,
					temperature: settings.temperature,
					stop: stopWords,
					prompt_options: {
						prefix: "",
						suffix: "",
						cursor_line_prefix: "",
						cursor_line_suffix: "",
					},
					completion_id: requestId,
					language_id: document.languageId,
					beta_mode: vscode.workspace
						.getConfiguration("IntelligentCodeCompletion")
						.get("betaMode", undefined),
					// calculate_hide_score: getHideScoreArgs(document, latest, cp),
					client_id,
					file_project_path: relativePath,
					project_path: workspaceFolder,
					code_path: "",
					user_id: "",
					repo: vscode.workspace?.name?.split(" ")[0] ?? "",
					git_path: "",
					parent_id: parentId,
					trigger_mode: acception === CompletionAcception.Accepted ? "continue" : "",
					import_content: importContent,
				},
			},
		)
		fetching = false
		// 插入到编辑器
		editor.edit((editBuilder) => {
			const suggestion = acquireCompletionText(completion)
			vscode.languages.registerHoverProvider(document.languageId, {
				provideHover(document, position) {
					return new vscode.Hover("💡 AI 建议:\n" + suggestion)
				},
			})
			editBuilder.insert(position, suggestion)
			acception = CompletionAcception.Accepted
			parentId = acquireCompletionId(completion)
		})
	} catch (error) {
		fetching = false
		outputChannel.append(`[补全失败] ${error.message}`)
	}
}

function acquireCompletionId(resp: Completion): string {
	if (!resp || !resp.choices || resp.choices.length === 0 || !resp.id) {
		return ""
	}

	return resp.id
}

function acquireCompletionText(resp: Completion): string {
	if (!resp || !resp.choices || resp.choices.length === 0) {
		return ""
	}

	let text = ""
	for (const choice of resp.choices) {
		if (choice.text) {
			text = choice.text.trim()
			if (text.length > 0) {
				break
			}
		}
	}
	if (!text) {
		return ""
	}
	// Since Chinese characters occupy 3 bytes, the plugin may be affected by Max Tokens. When the result is returned, only half of the last Chinese character is returned, resulting in garbled characters.
	// The garbled characters need to be replaced with ''.
	if (text.includes("�")) {
		text = text.replace(/�/g, "")
	}
	return text
}
