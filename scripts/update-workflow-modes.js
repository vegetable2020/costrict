#!/usr/bin/env node

/**
 * Script to update WORKFLOW_MODES in packages/types/src/mode.ts
 * based on the customModes defined in .roomodes file
 */

const fs = require("fs")
const path = require("path")

// Paths
const roomodesPath = path.join(__dirname, "../.roomodes")
const modeTypesPath = path.join(__dirname, "../packages/types/src/mode.ts")

/**
 * Parse YAML-like content from .roomodes file
 */
function parseRoomodes(content) {
	const lines = content.split("\n")
	const result = { customModes: [] }
	let currentMode = null
	let inCustomInstructions = false
	let currentIndentLevel = 0

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		const trimmed = line.trim()

		// Skip empty lines and comments
		if (!trimmed || trimmed.startsWith("#")) continue

		// Check for customModes start
		if (trimmed === "customModes:") {
			continue
		}

		// Check for new mode entry (starts with - slug:)
		if (trimmed.startsWith("- slug:")) {
			// Save previous mode if exists
			if (currentMode) {
				result.customModes.push(currentMode)
			}

			// Start new mode
			currentMode = {
				slug: trimmed.split(":")[1].trim(),
				name: "",
				roleDefinition: "",
				whenToUse: "",
				description: "",
				customInstructions: "",
				groups: [],
				source: "project",
			}
			inCustomInstructions = false
			currentIndentLevel = 0
			continue
		}

		// Calculate indent level
		const indentLevel = line.length - line.trimStart().length

		// Process mode properties
		if (currentMode && trimmed.includes(":")) {
			const [key, ...valueParts] = trimmed.split(":")
			const value = valueParts.join(":").trim()

			// Handle customInstructions specially (multi-line)
			if (key.trim() === "customInstructions") {
				if (value === "|-") {
					inCustomInstructions = true
					currentMode.customInstructions = ""
					currentIndentLevel = indentLevel
				} else {
					currentMode.customInstructions = value.replace(/^["']|["']$/g, "")
				}
			} else if (key.trim() === "name") {
				currentMode.name = value.replace(/^["']|["']$/g, "")
			} else if (key.trim() === "roleDefinition") {
				currentMode.roleDefinition = value.replace(/^["']|["']$/g, "")
			} else if (key.trim() === "whenToUse") {
				currentMode.whenToUse = value.replace(/^["']|["']$/g, "")
			} else if (key.trim() === "description") {
				currentMode.description = value.replace(/^["']|["']$/g, "")
			} else if (key.trim() === "groups") {
				// Parse groups array
				if (value.startsWith("[") && value.endsWith("]")) {
					const groupsContent = value.slice(1, -1).trim()
					if (groupsContent) {
						currentMode.groups = groupsContent.split(",").map((g) => g.trim().replace(/^["']|["']$/g, ""))
					} else {
						currentMode.groups = []
					}
				}
			} else if (key.trim() === "source") {
				currentMode.source = value.replace(/^["']|["']$/g, "")
			}
		} else if (inCustomInstructions && indentLevel > currentIndentLevel) {
			// Handle multi-line customInstructions
			const instructionLine = line.trim()
			if (instructionLine) {
				if (currentMode.customInstructions) {
					currentMode.customInstructions += "\n" + instructionLine
				} else {
					currentMode.customInstructions = instructionLine
				}
			}
		} else if (inCustomInstructions && indentLevel <= currentIndentLevel) {
			// End of customInstructions block
			inCustomInstructions = false
		}
	}

	// Save last mode
	if (currentMode) {
		result.customModes.push(currentMode)
	}

	return result
}

/**
 * Escape TypeScript string properly
 */
function escapeTypeScriptString(str) {
	return str
		.replace(/\\/g, "\\\\") // Escape backslashes
		.replace(/"/g, '\\"') // Escape double quotes
		.replace(/\n/g, "\\n") // Escape newlines
		.replace(/\r/g, "\\r") // Escape carriage returns
}

/**
 * Generate TypeScript code for WORKFLOW_MODES array
 */
function generateWorkflowModesCode(modes) {
	const modeEntries = modes.map((mode) => {
		const entries = []

		entries.push(`\tslug: "${mode.slug}",`)
		entries.push(`\tname: "${mode.name}",`)

		if (mode.roleDefinition) {
			entries.push(`\troleDefinition:\n\t\t"${escapeTypeScriptString(mode.roleDefinition)}",`)
		}

		if (mode.whenToUse) {
			entries.push(`\twhenToUse:\n\t\t"${escapeTypeScriptString(mode.whenToUse)}",`)
		}

		if (mode.description) {
			entries.push(`\tdescription:\n\t\t"${escapeTypeScriptString(mode.description)}",`)
		}

		if (mode.customInstructions) {
			entries.push(`\tcustomInstructions:\n\t\t"${escapeTypeScriptString(mode.customInstructions)}",`)
		}

		// Handle groups array
		if (Array.isArray(mode.groups)) {
			if (mode.groups.length === 0) {
				entries.push(`\tgroups: [],`)
			} else {
				const groupsStr = mode.groups.map((g) => `"${g}"`).join(", ")
				entries.push(`\tgroups: [${groupsStr}],`)
			}
		}

		if (mode.source) {
			entries.push(`\tsource: "${mode.source}",`)
		}

		// Add workflow: true for all custom modes
		entries.push(`\tworkflow: true,`)

		return `{\n${entries.join("\n")}\n}`
	})

	return `const WORKFLOW_MODES: readonly modelType[] = [\n${modeEntries.join(",\n")},\n]`
}

/**
 * Update the WORKFLOW_MODES section in mode.ts
 */
function updateWorkflowModes() {
	try {
		console.log("📖 Reading .roomodes file...")
		const roomodesContent = fs.readFileSync(roomodesPath, "utf8")

		console.log("🔍 Parsing .roomodes content...")
		const roomodesData = parseRoomodes(roomodesContent)

		if (!roomodesData.customModes || roomodesData.customModes.length === 0) {
			console.log("⚠️  No custom modes found in .roomodes")
			return
		}

		console.log(`📝 Found ${roomodesData.customModes.length} custom modes`)

		console.log("🏗️  Generating TypeScript code...")
		const newWorkflowModesCode = generateWorkflowModesCode(roomodesData.customModes)

		console.log("📖 Reading existing mode.ts file...")
		const existingContent = fs.readFileSync(modeTypesPath, "utf8")

		// Find the WORKFLOW_MODES section
		const workflowModesStart = existingContent.indexOf("const WORKFLOW_MODES: readonly modelType[] = [")
		const workflowModesEnd = existingContent.indexOf("]", workflowModesStart) + 1

		if (workflowModesStart === -1 || workflowModesEnd === -1) {
			throw new Error("Could not find WORKFLOW_MODES section in mode.ts")
		}

		console.log("🔄 Updating WORKFLOW_MODES section...")

		// Replace the WORKFLOW_MODES section
		const before = existingContent.substring(0, workflowModesStart)
		const after = existingContent.substring(workflowModesEnd)
		const updatedContent = before + newWorkflowModesCode + after

		console.log("💾 Writing updated content to mode.ts...")
		fs.writeFileSync(modeTypesPath, updatedContent, "utf8")

		console.log("✅ Successfully updated WORKFLOW_MODES in packages/types/src/mode.ts")
		console.log(`📊 Updated ${roomodesData.customModes.length} modes:`)
		roomodesData.customModes.forEach((mode) => {
			console.log(`   - ${mode.slug}: ${mode.name}`)
		})
	} catch (error) {
		console.error("❌ Error updating workflow modes:", error.message)
		process.exit(1)
	}
}

// Main execution
if (require.main === module) {
	console.log("🚀 Starting workflow modes update...")
	updateWorkflowModes()
	console.log("🎉 Workflow modes update completed!")
}

module.exports = { updateWorkflowModes, parseRoomodes, generateWorkflowModesCode }
