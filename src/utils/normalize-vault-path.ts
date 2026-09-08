/**
 * The path form accepted by Obsidian's Vault APIs: forward slashes, with no
 * leading or trailing separator. Kept independent from the Obsidian runtime
 * so domain code can normalize persisted Vault paths without a host process.
 */
export function normalizeVaultPath(path?: string) {
	if (!path) return ''
	return path
		.replace(/[\\/]+/g, '/')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
}
