import { decode as decodeHtmlEntity } from 'html-entities'
import { isArray } from 'lodash-es'
import { Vault } from 'obsidian'
import { basename, isAbsolute } from 'path'
import { isNotNil } from 'ramda'
import { createClient, WebDAVClient } from 'webdav'
import { getDelta } from '~/api/delta'
import { getLatestDeltaCursor } from '~/api/latestDeltaCursor'
import { NS_DAV_ENDPOINT } from '~/consts'
import { StatModel } from '~/model/stat.model'
import { useSettings } from '~/settings'
import { deltaCacheKV } from '~/storage'
import { getDBKey } from '~/utils/get-db-key'
import { getRootFolderName } from '~/utils/get-root-folder-name'
import GlobMatch, {
	extendRules,
	isVoidGlobMatchOptions,
	needIncludeFromGlobRules,
} from '~/utils/glob-match'
import { isSub } from '~/utils/is-sub'
import { stdRemotePath } from '~/utils/std-remote-path'
import { traverseWebDAV } from '~/utils/traverse-webdav'
import AbstractFileSystem from './fs.interface'
import completeLossDir from './utils/complete-loss-dir'

export class NutstoreFileSystem implements AbstractFileSystem {
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
				const { response } = await getDelta({
					token: this.options.token,
					cursor,
					folderName: getRootFolderName(this.options.remoteBaseDir),
				})
				if (response.cursor === cursor) {
					break
				}
				if (response.reset) {
					deltaCache.deltas = []
					deltaCache.files = await traverseWebDAV(
						this.options.token,
						this.options.remoteBaseDir,
					)
					cursor = await getLatestDeltaCursor({
						token: this.options.token,
						folderName: getRootFolderName(this.options.remoteBaseDir),
					}).then((d) => d?.response?.cursor)
					deltaCache.originCursor = cursor
				} else if (response.delta.entry) {
					if (!isArray(response.delta.entry)) {
						response.delta.entry = [response.delta.entry]
					}
					if (response.delta.entry.length > 0) {
						deltaCache.deltas.push(response)
					}
					if (response.hasMore) {
						cursor = response.cursor
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
		deltaCache.deltas.forEach((delta) => {
			delta.delta.entry.forEach((entry) => {
				entry.path = decodeHtmlEntity(entry.path)
			})
		})
		deltaCache.files.forEach((file) => {
			file.path = decodeHtmlEntity(file.path)
		})
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
		const base = stdRemotePath(this.options.remoteBaseDir)
		const subPath = new Set<string>()
		for (let { path } of stats) {
			if (path.endsWith('/')) {
				path = path.slice(0, path.length - 1)
			}
			if (!path.startsWith('/')) {
				path = `/${path}`
			}
			if (isSub(base, path)) {
				subPath.add(path)
			}
		}
		const contents = [...subPath]
			.map((path) => filesMap.get(path))
			.filter(isNotNil)
		for (const item of contents) {
			if (isAbsolute(item.path)) {
				item.path = item.path.replace(this.options.remoteBaseDir, '')
				if (item.path.startsWith('/')) {
					item.path = item.path.slice(1)
				}
			}
		}
		const settings = await useSettings()
		const exclusions = extendRules(
			(settings?.filterRules.exclusionRules ?? [])
				.filter((opt) => !isVoidGlobMatchOptions(opt))
				.map(({ expr, options }) => new GlobMatch(expr, options)),
		)
		const inclusion = extendRules(
			(settings?.filterRules.inclusionRules ?? [])
				.filter((opt) => !isVoidGlobMatchOptions(opt))
				.map(({ expr, options }) => new GlobMatch(expr, options)),
		)
		const filteredContents = contents.filter((item) =>
			needIncludeFromGlobRules(item.path, inclusion, exclusions),
		)
		return completeLossDir(contents, filteredContents)
	}
}
