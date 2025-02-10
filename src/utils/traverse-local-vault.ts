import dayjs from 'dayjs'
import { isNotJunk } from 'junk'
import { partial } from 'lodash-es'
import { normalizePath, Vault } from 'obsidian'
import { basename, isAbsolute, join } from 'path'
import { isNotNil } from 'ramda'
import { StatModel } from '~/model/stat.model'

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
		[...files, ...folders].map(partial(toStatModel, vault)),
	).then((arr) => arr.filter(isNotNil))
	return [
		contents,
		await Promise.all(folders.map(partial(traverseLocalVault, vault))),
	].flat(2)
}

export async function toStatModel(
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
		mtime: dayjs(stat.mtime),
	}
}
