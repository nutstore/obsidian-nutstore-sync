import {
	AGENTS_MOUNT_POINT,
	BASH_TMP_MOUNT_POINT,
	BUILTIN_SKILLS_MOUNT_POINT,
	SETTINGS_FILE_PATH,
	VAULT_MOUNT_POINT,
} from './mount-points'

/**
 * Stable routing information for the virtual filesystem exposed to agents.
 * This deliberately describes mount semantics, not the vault's live contents.
 */
export function createVirtualFilesystemGuidance() {
	return [
		'<virtual-filesystem>',
		`${VAULT_MOUNT_POINT} is the Obsidian vault base filesystem; relative paths resolve here.`,
		`${AGENTS_MOUNT_POINT} is a hidden dot-folder containing user Skills and plugin data. Inspect it only when the task or a loaded Skill requires it.`,
		`${BUILTIN_SKILLS_MOUNT_POINT} contains bundled Skills and is read-only; use the exact paths supplied by workspace context.`,
		`${BASH_TMP_MOUNT_POINT} is for temporary, scratch, debug, and intermediate files.`,
		`${SETTINGS_FILE_PATH} is a virtual live settings file for configuration-capable tools; it contains whitelist fields only, never credentials.`,
		'Use relative paths for vault files and absolute virtual paths for mounted or internal paths.',
		'When replying, cite vault files by their vault-relative path (for example notes/idea.md); describe internal paths without exposing them unless asked.',
		'This is a routing map, not an instruction to enumerate or scan every mount. Read the smallest relevant scope and stop when evidence is sufficient.',
		'</virtual-filesystem>',
	].join('\n')
}
