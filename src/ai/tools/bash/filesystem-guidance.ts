import {
	AGENTS_MOUNT_POINT,
	APPS_MOUNT_POINT,
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
		`${APPS_MOUNT_POINT}/<appId>/ holds real App files: manifest.json, index.html and any relative css/js/assets. data.json, logs.jsonl and state.json there are host-owned and read-only. App source edits hot-reload the App; use "app open [appId]" to show it.`,
		`${BUILTIN_SKILLS_MOUNT_POINT} contains bundled Skills and is read-only; use the exact paths supplied by workspace context.`,
		`${BASH_TMP_MOUNT_POINT} is the only scratch area for temporary, debug, and intermediate files, and it is still a vault folder: its files are real, hidden, and synced with the vault. Delete them when the task ends.`,
		`${SETTINGS_FILE_PATH} is a virtual live settings file for configuration-capable tools; it contains whitelist fields only, never credentials.`,
		'Use relative paths for vault files and absolute virtual paths for mounted or internal paths.',
		`This map is the whole machine: the shell runs sandboxed in the browser with no access to the device filesystem, so there is no Linux and no /bin, /dev, /etc, /home, /proc, /usr, /var or bare /tmp. A redirected write such as "echo hi > /dev/null" creates an ordinary vault note instead of discarding output, and "echo hi > /tmp/x.txt" creates /tmp/x.txt at the vault root. Never use host-style paths to discard output or to stage scratch files; treat every vault write as real user data the user sees and syncs.`,
		'When replying, cite vault files by their vault-relative path (for example notes/idea.md); describe internal paths without exposing them unless asked.',
		'This is a routing map, not an instruction to enumerate or scan every mount. Read the smallest relevant scope and stop when evidence is sufficient.',
		'</virtual-filesystem>',
	].join('\n')
}
