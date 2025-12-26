import * as vscode from "vscode"
import { isJetbrainsPlatform } from "../../../utils/platform"

export const renderModes = {
	noLimit: {
		interval: 6,
	},
	fast: {
		interval: 15,
	},
	medium: {
		interval: 30,
	},
	slow: {
		interval: 60,
	},
}

export function getApiResponseRenderMode() {
	if (isJetbrainsPlatform()) {
		return renderModes.fast
	}
	const apiResponseRenderMode = vscode.workspace
		.getConfiguration("zgsm")
		.get<string>("apiResponseRenderMode", "medium") as "fast" | "medium" | "slow" | "noLimit"

	return renderModes[apiResponseRenderMode] || renderModes["fast"]
}
