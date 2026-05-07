import { normalizePath, TFile, TFolder, Vault } from 'obsidian'
import { basename } from 'path-browserify'
import { StatModel } from '~/model/stat.model'
import { isAdapterPath } from './local-vault-io'

export async function statVaultItem(
	vault: Vault,
	path: string,
): Promise<StatModel | undefined> {
	path = normalizePath(path)
	if (!isAdapterPath(vault, path)) {
		const file = vault.getAbstractFileByPath(path)
		if (!file) {
			return undefined
		}
		if (file instanceof TFolder) {
			return {
				path,
				basename: basename(path),
				isDir: true,
				isDeleted: false,
			}
		}
		if (file instanceof TFile) {
			return {
				path,
				basename: basename(path),
				isDir: false,
				isDeleted: false,
				mtime: file.stat.mtime,
				size: file.stat.size,
			}
		}
		return undefined
	}

	const adapterStat = await vault.adapter.stat(path)
	if (!adapterStat) {
		return undefined
	}
	if (adapterStat.type === 'folder') {
		return {
			path,
			basename: basename(path),
			isDir: true,
			isDeleted: false,
			mtime: adapterStat.mtime,
		}
	}
	if (adapterStat.type === 'file') {
		return {
			path,
			basename: basename(path),
			isDir: false,
			isDeleted: false,
			mtime: adapterStat.mtime,
			size: adapterStat.size,
		}
	}
}
