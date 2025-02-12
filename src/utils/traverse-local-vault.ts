import { isNotJunk } from 'junk'
import { partial } from 'lodash-es'
import { normalizePath, Vault } from 'obsidian'
import { basename, isAbsolute, join } from 'path'
import { isNotNil } from 'ramda'
import { StatModel } from '~/model/stat.model'
import { statVaultItem } from './stat-vault-item'

export async function traverseLocalVault(
	vault: Vault,
	from: string = ``,
): Promise<StatModel[]> {
	if (!isAbsolute(from)) {
		from = join(vault.getRoot().path, from)
	}
	const normPath = normalizePath(from)
	let { files, folders } = await vault.adapter.list(normPath)
	files = files.filter(isNotJunk)
	folders = folders.filter(
		(path) => !['.git', '.obsidian'].includes(basename(path)),
	)
	const contents = await Promise.all(
		[...files, ...folders].map(partial(statVaultItem, vault)),
	).then((arr) => arr.filter(isNotNil))
	return [
		contents,
		await Promise.all(folders.map(partial(traverseLocalVault, vault))),
	].flat(2)
}
