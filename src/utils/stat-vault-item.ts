import { normalizePath, Vault } from 'obsidian'
import { basename } from 'path'
import { StatModel } from '~/model/stat.model'

export async function statVaultItem(
	vault: Vault,
	path: string,
): Promise<StatModel | undefined> {
	const stat = await vault.adapter.stat(normalizePath(path))
	if (!stat) {
		return undefined
	}
	return {
		path,
		basename: basename(path),
		isDir: stat.type === 'folder',
		isDeleted: false,
		mtime: new Date(stat.mtime).valueOf(),
		size: stat.size,
	}
}
