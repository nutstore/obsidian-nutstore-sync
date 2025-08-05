import { normalizePath, TFile, TFolder, Vault } from 'obsidian'
import { basename } from 'path'
import { StatModel } from '~/model/stat.model'

export async function statVaultItem(
	vault: Vault,
	path: string,
): Promise<StatModel | undefined> {
	const file = vault.getAbstractFileByPath(normalizePath(path))
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
	} else if (file instanceof TFile) {
		return {
			path,
			basename: basename(path),
			isDir: false,
			isDeleted: false,
			mtime: file.stat.mtime,
			size: file.stat.size,
		}
	}
}
