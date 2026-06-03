import { ButtonComponent, Notice, Setting } from 'obsidian'
import type { Subscription } from 'rxjs'
import CacheClearModal from '~/components/CacheClearModal'
import { IN_DEV } from '~/consts'
import { onGcProgress } from '~/events/gc-progress'
import i18n from '~/i18n'
import { blobStore } from '~/storage/blob'
import logger from '~/utils/logger'
import BaseSettings from './settings.base'

export default class CacheSettings extends BaseSettings {
	private gcUnlockWatcherActive = false
	private gcWatcherGeneration = 0
	private gcButton: ButtonComponent | undefined
	private gcProgressSub: Subscription | undefined
	private readonly blobGarbageCount = 5000
	private readonly blobGarbageSizeBytes = 64 * 1024

	async display() {
		this.containerEl.empty()
		new Setting(this.containerEl)
			.setName(i18n.t('settings.cache.title'))
			.setHeading()

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
								const message =
									error instanceof Error ? error.message : String(error)
								new Notice(`Error clearing cache: ${message}`)
							}
						}).open()
					})
			})

		// garbage collection
		const gcRunning = this.plugin.gcService.isRunningNow()
		this.watchGcUnlock(gcRunning)

		this.gcProgressSub?.unsubscribe()
		this.gcProgressSub = onGcProgress().subscribe(({ current, total }) => {
			const pct = total === 0 ? 100 : Math.round((current / total) * 100)
			this.gcButton?.setButtonText(`${pct}%`)
		})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.cache.gcName'))
			.setDesc(i18n.t('settings.cache.gcDesc'))
			.addButton((button) => {
				this.gcButton = button
				button.setButtonText(
					gcRunning
						? i18n.t('settings.cache.gcRunning')
						: i18n.t('settings.cache.gc'),
				)
				if (gcRunning) {
					button.setDisabled(true)
				}
				button.onClick(() => {
					button.buttonEl.disabled = true
					button.setButtonText(i18n.t('settings.cache.gcRunning'))
					void (async () => {
						try {
							const result = await this.plugin.gcService.runBlobGc()
							if (result.ok) {
								new Notice(
									i18n.t('settings.cache.gcCompleted', {
										count: result.deletedCount,
									}),
								)
							}
						} catch (error) {
							logger.error('Error running blob GC:', error)
							new Notice(`Error: ${(error as Error).message}`)
						} finally {
							await this.display()
						}
					})()
				})
			})

		if (IN_DEV) {
			new Setting(this.containerEl)
				.setName(i18n.t('settings.cache.generateBlobGarbageName'))
				.setDesc(
					i18n.t('settings.cache.generateBlobGarbageDesc', {
						count: this.blobGarbageCount,
						sizeKiB: this.blobGarbageSizeBytes / 1024,
					}),
				)
				.addButton((button) => {
					button
						.setButtonText(i18n.t('settings.cache.generateBlobGarbage'))
						.onClick(async () => {
							button.setDisabled(true)
							try {
								new Notice(i18n.t('settings.cache.generateBlobGarbageRunning'))
								const created = await this.generateBlobGarbage()
								new Notice(
									i18n.t('settings.cache.generateBlobGarbageDone', {
										count: created,
									}),
								)
							} catch (error) {
								logger.error('Error generating blob garbage:', error)
								new Notice(`Error: ${(error as Error).message}`)
							} finally {
								button.setDisabled(false)
							}
						})
				})
		}
	}

	hide() {
		this.gcWatcherGeneration++
		this.gcUnlockWatcherActive = false
		this.gcProgressSub?.unsubscribe()
		this.gcProgressSub = undefined
		this.gcButton = undefined
	}

	private watchGcUnlock(gcRunning: boolean) {
		if (!gcRunning) {
			this.gcUnlockWatcherActive = false
			return
		}

		if (this.gcUnlockWatcherActive) {
			return
		}

		this.gcUnlockWatcherActive = true
		const generation = this.gcWatcherGeneration
		void this.plugin.gcService.waitUntilIdle().then(() => {
			if (generation !== this.gcWatcherGeneration) {
				return
			}
			this.gcUnlockWatcherActive = false
			if (!document.contains(this.containerEl)) {
				return
			}
			void this.display()
		})
	}

	private async generateBlobGarbage() {
		function createRandomBytes(size: number) {
			const bytes = new Uint8Array(size)
			if (globalThis.crypto?.getRandomValues) {
				globalThis.crypto.getRandomValues(bytes)
				return bytes
			}
			for (let i = 0; i < bytes.length; i++) {
				bytes[i] = Math.floor(Math.random() * 256)
			}
			return bytes
		}

		let created = 0
		for (let i = 0; i < this.blobGarbageCount; i++) {
			const payload = createRandomBytes(this.blobGarbageSizeBytes)
			await blobStore.store(payload.buffer)
			created++
		}
		return created
	}
}
