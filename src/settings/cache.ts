import { Notice, Setting } from 'obsidian'
import { join } from 'path'
import CacheClearModal from '~/components/CacheClearModal'
import CacheRestoreModal from '~/components/CacheRestoreModal'
import CacheSaveModal from '~/components/CacheSaveModal'
import SelectRemoteBaseDirModal from '~/components/SelectRemoteBaseDirModal'
import i18n from '~/i18n'
import { blobKV, deltaCacheKV, syncRecordKV } from '~/storage/kv'
import { getDBKey } from '~/utils/get-db-key'
import logger from '~/utils/logger'
import { stdRemotePath } from '~/utils/std-remote-path'
import BaseSettings from './settings.base'

export interface ExportedStorage {
	deltaCache: string
	exportedAt: string
}

export default class CacheSettings extends BaseSettings {
	async display() {
		this.containerEl.empty()
		new Setting(this.containerEl)
			.setName(i18n.t('settings.cache.title'))
			.setHeading()

		// set remote cache directory
		new Setting(this.containerEl)
			.setName(i18n.t('settings.cache.remoteCacheDir.name'))
			.setDesc(i18n.t('settings.cache.remoteCacheDir.desc'))
			.addText((text) => {
				text
					.setPlaceholder(i18n.t('settings.cache.remoteCacheDir.placeholder'))
					.setValue(this.remoteCacheDir)
					.onChange(async (value) => {
						this.plugin.settings.remoteCacheDir = value
						await this.plugin.saveSettings()
					})
				text.inputEl.addEventListener('blur', async () => {
					this.plugin.settings.remoteCacheDir = this.remoteCacheDir
					await this.plugin.saveSettings()
					this.display()
				})
			})
			.addButton((button) => {
				button.setIcon('folder').onClick(() => {
					new SelectRemoteBaseDirModal(this.app, this.plugin, async (path) => {
						this.plugin.settings.remoteCacheDir = path
						await this.plugin.saveSettings()
						this.display()
					}).open()
				})
			})

		// Save and restore cache
		new Setting(this.containerEl)
			.setName(i18n.t('settings.cache.dumpName'))
			.setDesc(i18n.t('settings.cache.dumpDesc'))
			.addButton((button) => {
				button.setButtonText(i18n.t('settings.cache.dump')).onClick(() => {
					new CacheSaveModal(this.plugin, this.remoteCacheDir, () =>
						this.display(),
					).open()
				})
			})
			.addButton((button) => {
				button.setButtonText(i18n.t('settings.cache.restore')).onClick(() => {
					new CacheRestoreModal(this.plugin, this.remoteCacheDir, () =>
						this.display(),
					).open()
				})
			})

		// clear
		new Setting(this.containerEl)
			.setName(i18n.t('settings.cache.clearName'))
			.setDesc(i18n.t('settings.cache.clearDesc'))
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.cache.clear'))
					.onClick(async () => {
						new CacheClearModal(this.plugin, async (options) => {
							try {
								const cleared =
									await CacheClearModal.clearSelectedCaches(options)
								if (cleared.length > 0) {
									new Notice(i18n.t('settings.cache.cleared'))
								} else {
									new Notice(
										i18n.t('settings.cache.clearModal.nothingSelected'),
									)
								}
							} catch (error) {
								logger.error('Error clearing cache:', error)
								new Notice(`Error clearing cache: ${error.message}`)
							}
						}).open()
					})
			})
	}

	get remoteCacheDir() {
		return stdRemotePath(
			this.plugin.settings.remoteCacheDir?.trim() ||
				this.plugin.manifest.name.trim(),
		)
	}

	get remoteCachePath() {
		const filename = getDBKey(
			this.app.vault.getName(),
			this.plugin.settings.remoteDir,
		)
		return join(this.remoteCacheDir, filename + '.json')
	}

	async createRemoteCacheDir() {
		const webdav = await this.plugin.webDAVService.createWebDAVClient()
		return await webdav.createDirectory(this.remoteCacheDir, {
			recursive: true,
		})
	}

	/**
	 * Clear the local cache
	 * @param options Options specifying which caches to clear
	 */
	async clearCache({
		deltaCacheEnabled = true,
		syncRecordEnabled = true,
		blobEnabled = true,
	} = {}) {
		if (deltaCacheEnabled) {
			await deltaCacheKV.clear()
		}

		if (syncRecordEnabled) {
			await syncRecordKV.clear()
		}

		if (blobEnabled) {
			await blobKV.clear()
		}
	}
}
