import { Vault } from 'obsidian'
import path, { basename } from 'path'
import { createClient, WebDAVClient } from 'webdav'
import { getDelta } from '~/api/delta'
import { getLatestDeltaCursor } from '~/api/latestDeltaCursor'
import { DAV_API } from '~/consts'
import { StatModel } from '~/model/stat.model'
import { deltaCacheKV } from '~/storage'
import { getDBKey } from '~/utils/get-db-key'
import { getRootFolderName } from '~/utils/get-root-folder-name'
import { traverseWebDAV } from '~/utils/traverse-webdav'
import IFileSystem from './fs.interface'

export class NutstoreFileSystem implements IFileSystem {
	private webdav: WebDAVClient

	constructor(
		private options: {
			vault: Vault
			token: string
			remoteBaseDir: string
		},
	) {
		this.webdav = createClient(DAV_API, {
			headers: {
				Authorization: `Basic ${this.options.token}`,
			},
		})
	}

	async walk() {
		const kvKey = getDBKey(
			this.options.vault.getName(),
			this.options.remoteBaseDir,
		)
		let deltaCache = await deltaCacheKV.get(kvKey)
		if (deltaCache) {
			let cursor = deltaCache.deltas.at(-1)?.cursor ?? deltaCache.originCursor
			while (true) {
				const events = await getDelta({
					token: this.options.token,
					cursor,
					folderName: getRootFolderName(this.options.remoteBaseDir),
				})
				if (events.response.cursor === cursor) {
					break
				}
				if (events.response.reset) {
					deltaCache.deltas = []
					deltaCache.files = await traverseWebDAV(
						this.webdav,
						this.options.remoteBaseDir,
					)
					cursor = await getLatestDeltaCursor({
						token: this.options.token,
						folderName: getRootFolderName(this.options.remoteBaseDir),
					}).then((d) => d?.response?.cursor)
				} else if (events.response.delta.entry.length > 0) {
					deltaCache.deltas.push(events.response)
					if (events.response.hasMore) {
						cursor = events.response.cursor
					} else {
						break
					}
				} else {
					break
				}
			}
		} else {
			const files = await await traverseWebDAV(
				this.webdav,
				this.options.remoteBaseDir,
			)
			const {
				response: { cursor: originCursor },
			} = await getLatestDeltaCursor({
				token: this.options.token,
				folderName: getRootFolderName(this.options.remoteBaseDir),
			})
			deltaCache = {
				files,
				originCursor,
				deltas: [],
			}
		}
		await deltaCacheKV.set(kvKey, deltaCache)
		const deltasMap = new Map(
			deltaCache.deltas.flatMap((d) => d.delta.entry.map((d) => [d.path, d])),
		)
		const filesMap = new Map<string, StatModel>(
			deltaCache.files.map((d) => [d.path, d]),
		)
		for (const delta of deltasMap.values()) {
			if (delta.isDeleted) {
				filesMap.delete(delta.path)
				continue
			}
			filesMap.set(delta.path, {
				path: delta.path,
				basename: basename(delta.path),
				isDir: delta.isDir,
				isDeleted: delta.isDeleted,
				mtime: new Date(delta.modified).valueOf(),
			})
		}
		const contents = [...filesMap.values()]
		for (const item of contents) {
			if (path.isAbsolute(item.path)) {
				item.path = path.relative(this.options.remoteBaseDir, item.path)
			}
		}
		return contents
	}
}
