import fs from "fs"
import path from "path"
import os from "os"
import * as vscode from "vscode"

let loaded = false

export function loadIdeaShellEnvOnce(context: vscode.ExtensionContext) {
	if (loaded) return
	loaded = true

	try {
		const snapshotFile = resolveSnapshotPath()
		if (!snapshotFile || !fs.existsSync(snapshotFile)) {
			console.info("[shell-env] snapshot not found, skipping")
			return
		}

		const raw = fs.readFileSync(snapshotFile, "utf-8")
		const shellEnv = JSON.parse(raw) as Record<string, string>

		mergeIntoProcessEnv(shellEnv)

		console.info(`[shell-env] loaded snapshot from ${snapshotFile}, entries=${Object.keys(shellEnv).length}`)
	} catch (e) {
		console.warn("[shell-env] failed to load snapshot", e)
	}
}

function resolveSnapshotPath(): string | null {
	const filename = "idea-shell-env.json"

	if (process.platform === "win32") {
		const base = process.env.LOCALAPPDATA
		return base ? path.join(base, filename) : null
	}

	if (process.platform === "darwin") {
		return path.join(os.homedir(), "Library", "Caches", filename)
	}

	return path.join(os.homedir(), ".cache", filename)
}

function mergePath(shellPath: string) {
	const delimiter = process.platform === "win32" ? ";" : ":"

	const current = process.env.PATH ?? ""
	const currentEntries = current.split(delimiter).filter(Boolean)

	const shellEntries = shellPath.split(delimiter).filter(Boolean)

	// 保留顺序：shell PATH 在前，VS Code PATH 在后
	const merged = [...shellEntries, ...currentEntries.filter((p) => !shellEntries.includes(p))]

	process.env.PATH = merged.join(delimiter)
}

function mergeIntoProcessEnv(shellEnv: Record<string, string>) {
	for (const [key, value] of Object.entries(shellEnv)) {
		if (key === "PATH") {
			mergePath(value)
		} else if (!(key in process.env)) {
			process.env[key] = value
		}
	}
}
