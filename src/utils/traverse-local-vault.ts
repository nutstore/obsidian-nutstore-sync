import { isNil, partial } from 'lodash-es'
import { normalizePath, TFolder, Vault } from 'obsidian'
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
		const folder = vault.getAbstractFileByPath(normalizePath(from))
		if (!folder || !(folder instanceof TFolder)) {
			continue
		}
		const files = folder.children
			.filter((f) => !(f instanceof TFolder))
			.map((f) => f.path)
		let folders = folder.children
			.filter((f) => f instanceof TFolder)
			.map((f) => f.path)
		folders = folders.filter(folderFilter)
		q.push(...folders)
		const contents = await Promise.all(
			[...files, ...folders].map(partial(statVaultItem, vault)),
		).then((arr) => arr.filter(isNotNil))
		res.push(...contents)
	}
	return res
}
