import { isNil, partial } from 'lodash-es'
import { Vault } from 'obsidian'
import { isNotNil } from 'ramda'
import { StatModel } from '~/model/stat.model'
import { statVaultItem } from './stat-vault-item'

export async function traverseLocalVault(
	vault: Vault,
	filter: (path: string) => boolean,
) {
	const res: StatModel[] = []
	const q = [vault.getRoot().path]
	while (q.length > 0) {
		const from = q.shift()
		if (isNil(from)) {
			continue
		}
		let { files, folders } = await vault.adapter.list(from)
		files = files.filter(filter)
		folders = folders.filter(filter)
		q.push(...folders)
		const contents = await Promise.all(
			[...files, ...folders].map(partial(statVaultItem, vault)),
		).then((arr) => arr.filter(isNotNil))
		res.push(...contents)
	}
	return res
}
