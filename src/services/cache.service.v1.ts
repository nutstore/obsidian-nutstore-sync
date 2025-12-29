import { deflateSync, inflateSync } from 'fflate/browser'
import { Notice } from 'obsidian'
import { join } from 'path-browserify'
import superjson from 'superjson'
import { BufferLike } from 'webdav'
import { getDirectoryContents } from '~/api/webdav'
import i18n from '~/i18n'
import { ExportedStorage } from '~/settings/cache'
import { deltaCacheKV } from '~/storage/kv'
import { fileStatToStatModel } from '~/utils/file-stat-to-stat-model'
import { getDBKey } from '~/utils/get-db-key'
import logger from '~/utils/logger'
import { uint8ArrayToArrayBuffer } from '~/utils/uint8array-to-arraybuffer'
import type NutstorePlugin from '..'

/**
 * Service for handling cache operations (save, restore, delete, list)
 */
export default class CacheServiceV1 {
	constructor(
		private plugin: NutstorePlugin,
		private remoteCacheDir: string,
	) {}

	get key() {
		const kvKey = getDBKey(
			this.plugin.app.vault.getName(),
			this.plugin.remoteBaseDir,
		)
		return kvKey
	}
	/**
	 * Save the current cache to a file in the remote cache directory
	 */
	async saveCache(filename: string) {
		try {
			const webdav = await this.plugin.webDAVService.createWebDAVClient()
			const deltaCache = await deltaCacheKV.get(this.key)

			// Validate cache data exists
			if (!deltaCache) {
				throw new Error('No cache data to save')
			}

			const exportedStorage: ExportedStorage = {
				deltaCache,
				exportedAt: new Date().toISOString(),
			}

			// Encoding pipeline: superjson.stringify -> deflate level 9
			const serializedStr = superjson.stringify(exportedStorage)
			if (!serializedStr || serializedStr.length === 0) {
				throw new Error('Cache data serialization failed')
			}

			const encoder = new TextEncoder()

			const deflatedStorage = deflateSync(encoder.encode(serializedStr), {
				level: 9,
			}) as Uint8Array<ArrayBuffer>
			const filePath = join(this.remoteCacheDir, filename)

			await webdav.createDirectory(this.remoteCacheDir, { recursive: true })
			await webdav.putFileContents(
				filePath,
				uint8ArrayToArrayBuffer(deflatedStorage),
				{
					overwrite: true,
				},
			)

			new Notice(i18n.t('settings.cache.saveModal.success'))
			return Promise.resolve()
		} catch (error) {
			logger.error('Error saving cache:', error)
			new Notice(
				i18n.t('settings.cache.saveModal.error', {
					message: error.message,
				}),
			)
			return Promise.reject(error)
		}
	}

	/**
	 * Restore the cache from a file in the remote cache directory
	 */
	async restoreCache(filename: string) {
		try {
			const webdav = await this.plugin.webDAVService.createWebDAVClient()
			const filePath = join(this.remoteCacheDir, filename)

			const fileExists = await webdav.exists(filePath).catch(() => false)
			if (!fileExists) {
				new Notice(i18n.t('settings.cache.restoreModal.fileNotFound'))
				return Promise.reject(new Error('File not found'))
			}

			const fileContent = (await webdav.getFileContents(filePath, {
				format: 'binary',
			})) as BufferLike

			// Check if file content is empty
			if (!fileContent || fileContent.byteLength === 0) {
				throw new Error('Cache file is empty')
			}

			// Decoding pipeline: inflate -> superjson.parse
			const inflatedFileContent = inflateSync(new Uint8Array(fileContent))
			if (!inflatedFileContent || inflatedFileContent.length === 0) {
				throw new Error('Inflate failed or resulted in empty content')
			}

			const decoder = new TextDecoder()
			const decodedContent = decoder.decode(inflatedFileContent)
			if (!decodedContent || decodedContent.trim() === '') {
				throw new Error('Cache file content is invalid or empty')
			}

			const exportedStorage: ExportedStorage = superjson.parse(decodedContent)

			// Validate the structure of exported storage
			if (!exportedStorage || !exportedStorage.deltaCache) {
				throw new Error('Invalid cache file format')
			}

			const { deltaCache } = exportedStorage
			await deltaCacheKV.set(this.key, deltaCache)

			new Notice(i18n.t('settings.cache.restoreModal.success'))
			return Promise.resolve()
		} catch (error) {
			logger.error('Error restoring cache:', error)
			new Notice(
				i18n.t('settings.cache.restoreModal.error', {
					message: error.message,
				}),
			)
			return Promise.reject(error)
		}
	}

	/**
	 * Delete a cache file from the remote cache directory
	 */
	async deleteCache(filename: string): Promise<void> {
		try {
			const webdav = await this.plugin.webDAVService.createWebDAVClient()
			const filePath = join(this.remoteCacheDir, filename)

			await webdav.deleteFile(filePath)

			new Notice(i18n.t('settings.cache.restoreModal.deleteSuccess'))
			return Promise.resolve()
		} catch (error) {
			logger.error('Error deleting cache file:', error)
			new Notice(
				i18n.t('settings.cache.restoreModal.deleteError', {
					message: error.message,
				}),
			)
			return Promise.reject(error)
		}
	}

	/**
	 * Load the list of cache files from the remote cache directory
	 */
	async loadCacheFileList() {
		try {
			const webdav = await this.plugin.webDAVService.createWebDAVClient()
			const dirExists = await webdav
				.exists(this.remoteCacheDir)
				.catch(() => false)
			if (!dirExists) {
				await webdav.createDirectory(this.remoteCacheDir, { recursive: true })
				return []
			}
			const files = await getDirectoryContents(
				await this.plugin.getToken(),
				this.remoteCacheDir,
			)
			return files.map(fileStatToStatModel)
		} catch (error) {
			logger.error('Error loading cache file list:', error)
			throw error
		}
	}
}
