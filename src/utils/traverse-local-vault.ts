import { isNotJunk } from 'junk'
import { partial } from 'lodash-es'
import { normalizePath, Vault } from 'obsidian'
import { basename, isAbsolute, join } from 'path'
import { isNotNil } from 'ramda'
import { StatModel } from '~/model/stat.model'
import { SyncRecordModel } from '~/model/sync-record.model'
import { statVaultItem } from './stat-vault-item'

export async function traverseLocalVault(
	vault: Vault,
	records: Map<string, SyncRecordModel>,
	from: string = ``,
): Promise<StatModel[]> {
	if (!isAbsolute(from)) {
		from = join(vault.getRoot().path, from)
	}
	const normPath = normalizePath(from)
	let { files, folders } = await vault.adapter.list(normPath)
	files = files.filter(
		(path) =>
			records.has(normPath) || (isNotJunk(path) && isNotJunk(basename(path))),
	)
	folders = folders.filter(
		(path) => !['.git', vault.configDir].includes(basename(path)),
	)
	const contents = await Promise.all(
		[...files, ...folders].map(partial(statVaultItem, vault)),
	).then((arr) => arr.filter(isNotNil))
	return [
		contents,
		await Promise.all(folders.map(partial(traverseLocalVault, vault, records))),
	].flat(2)
}
