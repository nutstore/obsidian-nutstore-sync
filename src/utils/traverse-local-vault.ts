import { isNil, partial } from 'lodash-es'
import { normalizePath, Vault } from 'obsidian'
import { isNotNil } from 'ramda'
import { StatModel } from '~/model/stat.model'
import GlobMatch from './glob-match'
import { statVaultItem } from './stat-vault-item'

export async function traverseLocalVault(vault: Vault, from: string) {
	const res: StatModel[] = []
	const q = [from]
	const ignores = [
		new GlobMatch(`${vault.configDir}/plugins/*/node_modules`, {
			caseSensitive: true,
		}),
	]
	function folderFilter(path: string) {
		path = normalizePath(path)
		if (ignores.some((rule) => rule.test(path))) {
			return false
		}
		return true
	}

	while (q.length > 0) {
		const from = q.shift()
		if (isNil(from)) {
			continue
		}
		let { files, folders } = await vault.adapter.list(from)
		folders = folders.filter(folderFilter)
		q.push(...folders)
		const contents = await Promise.all(
			[...files, ...folders].map(partial(statVaultItem, vault)),
		).then((arr) => arr.filter(isNotNil))
		res.push(...contents)
	}
	return res
}
