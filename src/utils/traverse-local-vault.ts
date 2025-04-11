import { partial } from 'lodash-es'
import { normalizePath, Vault } from 'obsidian'
import { isAbsolute, join } from 'path'
import { isNotNil } from 'ramda'
import { StatModel } from '~/model/stat.model'
import GlobMatch from './glob-match'
import { statVaultItem } from './stat-vault-item'

export async function traverseLocalVault(
	vault: Vault,
	filters: GlobMatch[] = [],
	from: string = ``,
): Promise<StatModel[]> {
	if (!isAbsolute(from)) {
		from = join(vault.getRoot().path, from)
	}
	const normPath = normalizePath(from)
	let { files, folders } = await vault.adapter.list(normPath)
	files = files.filter((path) => filters.every((f) => !f.test(path)))
	folders = folders.filter((path) => filters.every((f) => !f.test(path)))
	const contents = await Promise.all(
		[...files, ...folders].map(partial(statVaultItem, vault)),
	).then((arr) => arr.filter(isNotNil))
	return [
		contents,
		await Promise.all(folders.map(partial(traverseLocalVault, vault, filters))),
	].flat(2)
}
