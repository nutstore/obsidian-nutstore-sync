import { App, Modal, Setting, moment } from 'obsidian'
import i18n from '~/i18n'
import CacheService from '~/services/cache.service'
import NutstorePlugin from '..'

export default class CacheSaveModal extends Modal {
	private cacheService: CacheService

	constructor(
		app: App,
		private plugin: NutstorePlugin,
		private remoteCacheDir: string,
		private onSuccess?: () => void,
	) {
		super(app)
		this.cacheService = new CacheService(plugin, remoteCacheDir)
	}

	onOpen() {
		const { contentEl } = this

		contentEl.createEl('h2', {
			text: i18n.t('settings.cache.saveModal.title'),
		})
		contentEl.createEl('p', {
			text: i18n.t('settings.cache.saveModal.description'),
			cls: 'setting-item-description',
		})

		const defaultFilename = moment().format('YYYY-MM-DD HH_mm_ss')

		const inputContainer = contentEl.createDiv()
		const filenameInput = inputContainer.createEl('input', {
			cls: 'w-full',
			type: 'text',
			value: defaultFilename,
		})

		new Setting(contentEl)
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.cache.saveModal.save'))
					.setCta()
					.onClick(async () => {
						try {
							await this.cacheService.saveCache(filenameInput.value)
							this.onSuccess?.()
							this.close()
						} catch (error) {
							// Error is already handled in the service
						}
					})
			})
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.cache.saveModal.cancel'))
					.onClick(() => {
						this.close()
					})
			})
	}

	onClose() {
		const { contentEl } = this
		contentEl.empty()
	}
}
