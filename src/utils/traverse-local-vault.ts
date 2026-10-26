import { normalizePath, Vault } from 'obsidian'
import { StatModel } from '~/model/stat.model'
import { isAbortError } from './abort'
import { LocalScanError } from './local-scan-error'
import { getConfigDirSystemTraversalRules } from './config-dir-rules'
import GlobMatch from './glob-match'
import { statVaultItem } from './stat-vault-item'

export async function traverseLocalVault(vault: Vault, from: string) {
	const res: StatModel[] = []
	const q = [from]
	const ignores = getConfigDirSystemTraversalRules(vault.configDir).map(
		(rule) => new GlobMatch(rule.expr, rule.options),
	)
	function folderFilter(path: string) {
		path = normalizePath(path)
		if (ignores.some((rule) => rule.test(path))) {
			return false
		}
		return true
	}

	while (q.length > 0) {
		const currentLevelPaths = q.splice(0)
		const levelResults = await Promise.all(
			currentLevelPaths.map(async (current) => {
				const folderPath = normalizePath(current)
				try {
					const listed = await vault.adapter.list(folderPath)
					const { files, folders } = listed
					const normalizedFiles = files.map((path) => normalizePath(path))
					const normalizedFolders = folders
						.map((path) => normalizePath(path))
						.filter(folderFilter)
					const contents = await Promise.all(
						[...normalizedFiles, ...normalizedFolders].map(async (path) => {
							const stat = await statVaultItem(vault, path)
							// A listed entry without metadata is an inconsistent snapshot,
							// including a file removed during scanning. Retry on the next trigger.
							if (!stat)
								throw new Error(`Listed entry has no metadata: '${path}'`)
							return stat
						}),
					)
					return { contents, folders: normalizedFolders }
				} catch (error) {
					if (isAbortError(error)) throw error
					throw new LocalScanError(folderPath, { cause: error })
				}
			}),
		)
		for (const { contents, folders } of levelResults) {
			q.push(...folders)
			res.push(...contents)
		}
	}
	return res
}
