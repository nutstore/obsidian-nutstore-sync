import { normalizePath, Vault } from 'obsidian'
import { SyncScope, type ScanSnapshot } from '~/sync/scope'
import { isAbortError } from './abort'
import { LocalScanError } from './local-scan-error'
import { getConfigDirSystemTraversalRules } from './config-dir-rules'
import GlobMatch from './glob-match'
import { statVaultItem } from './stat-vault-item'

export async function traverseLocalVault(
	vault: Vault,
	from: string,
	scope = new SyncScope(),
): Promise<ScanSnapshot> {
	const entries: ScanSnapshot['entries'] = []
	const issues: ScanSnapshot['issues'] = []
	const q = [from]
	const ignores = getConfigDirSystemTraversalRules(vault.configDir).map(
		(rule) => new GlobMatch(rule.expr, rule.options),
	)
	const included = (path: string, isDir: boolean) => {
		if (
			!scope.includes(path, isDir) ||
			ignores.some((rule) => rule.test(path))
		) {
			scope.protect(path)
			return false
		}
		return true
	}
	const report = (path: string, operation: 'list' | 'stat', cause: unknown) => {
		if (isAbortError(cause)) throw cause
		const issue = { path, operation, cause }
		issues.push(issue)
		scope.report(issue)
	}

	while (q.length > 0) {
		await Promise.all(
			q.splice(0).map(async (current) => {
				const folderPath = normalizePath(current)
				let listed: Awaited<ReturnType<typeof vault.adapter.list>>
				try {
					listed = await vault.adapter.list(folderPath)
				} catch (error) {
					if (isAbortError(error)) throw error
					if (current === from)
						throw new LocalScanError(folderPath, { cause: error })
					report(folderPath, 'list', error)
					return
				}
				await Promise.all(
					[
						...listed.files.map((path) => ({ path, isDir: false })),
						...listed.folders.map((path) => ({ path, isDir: true })),
					].map(async ({ path: rawPath, isDir }) => {
						const path = normalizePath(rawPath)
						if (!included(path, isDir)) return
						let stat
						try {
							stat = await statVaultItem(vault, path)
							if (!stat)
								throw new Error(`Listed entry has no metadata: '${path}'`)
						} catch (error) {
							report(path, 'stat', error)
							return
						}
						entries.push(stat)
						if (stat.isDir) q.push(path)
					}),
				)
			}),
		)
	}
	return {
		entries: entries.filter((stat) => scope.includes(stat.path, stat.isDir)),
		issues,
	}
}
