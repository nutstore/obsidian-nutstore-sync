import { Modal, Setting } from 'obsidian'
import i18n from '~/i18n'
import { blobKV, syncRecordKV, traverseWebDAVKV } from '~/storage/kv'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'

export interface CacheClearOptions {
	syncRecordEnabled: boolean
	blobEnabled: boolean
	traverseWebDAVEnabled: boolean
}

export default class CacheClearModal extends Modal {
	private options: CacheClearOptions = {
		syncRecordEnabled: false,
		blobEnabled: false,
		traverseWebDAVEnabled: false,
	}

	constructor(
		private plugin: NutstorePlugin,
		private onSuccess?: (options: CacheClearOptions) => void,
	) {
		super(plugin.app)
	}

	onOpen() {
		const { contentEl } = this

		new Setting(contentEl)
			.setName(i18n.t('settings.cache.clearModal.title'))
			.setDesc(i18n.t('settings.cache.clearModal.description'))

		const optionsContainer = contentEl.createDiv({
			cls: 'py-2',
		})

		// Sync Record Cache Option
		new Setting(optionsContainer)
			.setName(i18n.t('settings.cache.clearModal.syncRecordCache.name'))
			.setDesc(i18n.t('settings.cache.clearModal.syncRecordCache.desc'))
			.addToggle((toggle) => {
				toggle.setValue(this.options.syncRecordEnabled).onChange((value) => {
					this.options.syncRecordEnabled = value
				})
			})

		// Blob Cache Option
		new Setting(optionsContainer)
			.setName(i18n.t('settings.cache.clearModal.blobCache.name'))
			.setDesc(i18n.t('settings.cache.clearModal.blobCache.desc'))
			.addToggle((toggle) => {
				toggle.setValue(this.options.blobEnabled).onChange((value) => {
					this.options.blobEnabled = value
				})
			})

		// TraverseWebDAV Cache Option
		new Setting(optionsContainer)
			.setName(i18n.t('settings.cache.clearModal.traverseWebDAVCache.name'))
			.setDesc(i18n.t('settings.cache.clearModal.traverseWebDAVCache.desc'))
			.addToggle((toggle) => {
				toggle.setValue(this.options.traverseWebDAVEnabled).onChange((value) => {
					this.options.traverseWebDAVEnabled = value
				})
			})

		// Action buttons
		new Setting(contentEl)
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.cache.clearModal.cancel'))
					.onClick(() => {
						this.close()
					})
			})
			.addButton((button) => {
				let confirmed = false
				button
					.setButtonText(i18n.t('settings.cache.clear'))
					.onClick(async () => {
						if (confirmed) {
							try {
								if (this.onSuccess) {
									this.onSuccess(this.options)
								}
								this.close()
							} catch (error) {
								logger.error('Error clearing cache:', error)
							} finally {
								button.setButtonText(
									i18n.t('settings.cache.clearModal.confirm'),
								)
								button.buttonEl.classList.remove('mod-warning')
								confirmed = false
							}
						} else {
							confirmed = true
							button
								.setButtonText(i18n.t('settings.cache.confirm'))
								.setWarning()
						}
					})

				button.buttonEl.addEventListener('blur', () => {
					if (confirmed) {
						confirmed = false
						button.setButtonText(i18n.t('settings.cache.clear'))
						button.buttonEl.classList.remove('mod-warning')
					}
				})
			})
	}

	onClose() {
		const { contentEl } = this
		contentEl.empty()
	}

	/**
	 * Static method to clear selected caches
	 */
	static async clearSelectedCaches(options: CacheClearOptions) {
		const { syncRecordEnabled, blobEnabled, traverseWebDAVEnabled } = options
		const cleared = []

		try {
			if (syncRecordEnabled) {
				await syncRecordKV.clear()
				cleared.push(i18n.t('settings.cache.clearModal.syncRecordCache.name'))
			}

			if (blobEnabled) {
				await blobKV.clear()
				cleared.push(i18n.t('settings.cache.clearModal.blobCache.name'))
			}

			if (traverseWebDAVEnabled) {
				await traverseWebDAVKV.clear()
				cleared.push(i18n.t('settings.cache.clearModal.traverseWebDAVCache.name'))
			}

			return cleared
		} catch (error) {
			logger.error('Error clearing caches:', error)
			throw error
		}
	}
}
