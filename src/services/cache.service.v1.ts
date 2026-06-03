import { deflateSync, inflateSync } from 'fflate/browser'
import { hash as hashObject } from 'ohash'
import { normalize } from 'path-browserify'
import superjson from 'superjson'
import { BufferLike } from 'webdav'
import {
	cacheUploadMetaKV,
	traverseWebDAVKV,
	type TraverseWebDAVCache,
} from '~/storage'
import { getTraversalWebDAVDBKey } from '~/utils/get-db-key'
import logger from '~/utils/logger'
import { stdRemotePath } from '~/utils/std-remote-path'
import { isTraversalCacheCompatible } from '~/utils/traversal-cache-compat'
import {
	getRemoteSyncCacheDirPath,
	getRemoteSyncCacheFilePath,
	getSyncCacheLocalPath,
} from '~/utils/sync-cache-file'
import { uint8ArrayToArrayBuffer } from '~/utils/uint8array-to-arraybuffer'
import type NutstorePlugin from '..'

export interface ExportedStorage {
	exportedAt: string
	remoteBaseDir?: string
	traverseWebDAVCache?: TraverseWebDAVCache
}

export default class CacheServiceV1 {
	constructor(private plugin: NutstorePlugin) {}

	async restoreRemoteTraversalCacheIfMissing(): Promise<boolean> {
		try {
			const kvKey = await this.getKVKey()
			const localCache = await traverseWebDAVKV.get(kvKey)
			if (localCache?.queue?.length === 0) {
				return false
			}

			const webdav = await this.plugin.webDAVService.createWebDAVClient()
			const filePath = this.remoteCacheFilePath
			const fileExists = await webdav.exists(filePath).catch(() => false)
			if (!fileExists) {
				return false
			}

			const fileContent = (await webdav.getFileContents(filePath, {
				format: 'binary',
			})) as BufferLike
			const exportedStorage = this.decodeStorage(fileContent)
			if (!exportedStorage.traverseWebDAVCache) {
				return false
			}
			if (
				(exportedStorage.remoteBaseDir &&
					exportedStorage.remoteBaseDir !==
						stdRemotePath(this.plugin.remoteBaseDir)) ||
				!isTraversalCacheCompatible(
					exportedStorage.traverseWebDAVCache,
					this.plugin.remoteBaseDir,
				)
			) {
				logger.warn(
					'Skipping remote traversal cache restore: cache belongs to a different remote directory',
				)
				return false
			}

			await traverseWebDAVKV.set(kvKey, exportedStorage.traverseWebDAVCache)
			logger.info('Restored remote traversal cache')
			return true
		} catch (error) {
			logger.error('Error restoring remote traversal cache:', error)
			return false
		}
	}

	async saveRemoteTraversalCache(): Promise<boolean> {
		try {
			const traverseWebDAVCache = await traverseWebDAVKV.get(
				await this.getKVKey(),
			)
			if (!traverseWebDAVCache || traverseWebDAVCache.queue.length > 0) {
				return false
			}

			const filteredCache = this.withoutRemoteSyncCacheFile(traverseWebDAVCache)
			const nodesHash = hashObject(filteredCache.nodes)
			const metaKey = await this.getKVKey()

			const webdav = await this.plugin.webDAVService.createWebDAVClient()
			const remoteExists = await webdav
				.exists(this.remoteCacheFilePath)
				.catch(() => false)

			if (remoteExists) {
				const meta = await cacheUploadMetaKV.get(metaKey)
				if (meta?.nodesHash === nodesHash) {
					logger.debug('Skipping remote cache upload: content unchanged')
					return false
				}
			}

			const encodedStorage = this.encodeStorage({
				traverseWebDAVCache: filteredCache,
				exportedAt: new Date().toISOString(),
				remoteBaseDir: stdRemotePath(this.plugin.remoteBaseDir),
			})

			await webdav.createDirectory(this.remoteCacheDirPath, { recursive: true })
			await webdav.putFileContents(
				this.remoteCacheFilePath,
				uint8ArrayToArrayBuffer(encodedStorage),
				{ overwrite: true },
			)

			await cacheUploadMetaKV.set(metaKey, { nodesHash })
			logger.info('Saved remote traversal cache')
			return true
		} catch (error) {
			logger.error('Error saving remote traversal cache:', error)
			return false
		}
	}

	private encodeStorage(exportedStorage: ExportedStorage) {
		const serializedStr = superjson.stringify(exportedStorage)
		if (!serializedStr) {
			throw new Error('Cache data serialization failed')
		}
		return deflateSync(new TextEncoder().encode(serializedStr), {
			level: 9,
		}) as Uint8Array<ArrayBuffer>
	}

	private decodeStorage(fileContent: BufferLike): ExportedStorage {
		if (!fileContent || fileContent.byteLength === 0) {
			throw new Error('Cache file is empty')
		}
		const inflatedFileContent = inflateSync(new Uint8Array(fileContent))
		if (!inflatedFileContent.length) {
			throw new Error('Inflate failed or resulted in empty content')
		}
		const decodedContent = new TextDecoder().decode(inflatedFileContent)
		if (!decodedContent.trim()) {
			throw new Error('Cache file content is invalid or empty')
		}
		const exportedStorage: ExportedStorage = superjson.parse(decodedContent)
		if (!exportedStorage) {
			throw new Error('Invalid cache file format')
		}
		return exportedStorage
	}

	private async getKVKey() {
		return getTraversalWebDAVDBKey(
			await this.plugin.getToken(),
			this.plugin.remoteBaseDir,
		)
	}

	private withoutRemoteSyncCacheFile(
		cache: TraverseWebDAVCache,
	): TraverseWebDAVCache {
		const remoteCacheFilePath = normalize(this.remoteCacheFilePath)
		const localCacheFilePath = normalize(
			getSyncCacheLocalPath(this.plugin.app.vault.configDir),
		)
		const nodes: TraverseWebDAVCache['nodes'] = {}

		for (const [dirPath, stats] of Object.entries(cache.nodes)) {
			nodes[dirPath] = stats.filter((stat) => {
				const path = normalize(stat.path)
				return path !== remoteCacheFilePath && path !== localCacheFilePath
			})
		}

		return {
			rootCursor: cache.rootCursor,
			queue: [...cache.queue],
			nodes,
		}
	}

	private get remoteCacheFilePath() {
		return getRemoteSyncCacheFilePath(
			this.plugin.remoteBaseDir,
			this.plugin.app.vault.configDir,
		)
	}

	private get remoteCacheDirPath() {
		return getRemoteSyncCacheDirPath(
			this.plugin.remoteBaseDir,
			this.plugin.app.vault.configDir,
		)
	}
}
