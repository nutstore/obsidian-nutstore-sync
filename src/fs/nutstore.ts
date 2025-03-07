import { Vault } from 'obsidian'
import path, { basename, join } from 'path'
import { isNotNil } from 'ramda'
import { createClient, WebDAVClient } from 'webdav'
import { getDelta } from '~/api/delta'
import { getLatestDeltaCursor } from '~/api/latestDeltaCursor'
import { NS_DAV_ENDPOINT } from '~/consts'
import { StatModel } from '~/model/stat.model'
import { deltaCacheKV } from '~/storage'
import { getDBKey } from '~/utils/get-db-key'
import { getRootFolderName } from '~/utils/get-root-folder-name'
import { statsToMemfs } from '~/utils/stats-to-memfs'
import { stdRemotePath } from '~/utils/std-remote-path'
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
		this.webdav = createClient(NS_DAV_ENDPOINT, {
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
						this.options.token,
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
			const files = await traverseWebDAV(
				this.options.token,
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
				size: delta.size,
			})
		}
		const stats = Array.from(filesMap.values())
		if (stats.length === 0) {
			return []
		}
		const fs = statsToMemfs(stats)
		const base = stdRemotePath(this.options.remoteBaseDir)
		const subPath = (await fs.promises.readdir(base, {
			recursive: true,
		})) as string[]
		const contents = subPath
			.map((path) => filesMap.get(join(base, path)))
			.filter(isNotNil)
		for (const item of contents) {
			if (path.isAbsolute(item.path)) {
				item.path = path.relative(this.options.remoteBaseDir, item.path)
			}
		}
		return contents
	}
}
