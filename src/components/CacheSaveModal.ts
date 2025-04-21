import { Modal, Setting, moment } from 'obsidian'
import i18n from '~/i18n'
import CacheService from '~/services/cache.service.v1'
import NutstorePlugin from '..'

export default class CacheSaveModal extends Modal {
	private cacheService: CacheService

	constructor(
		private plugin: NutstorePlugin,
		private remoteCacheDir: string,
		private onSuccess?: () => void,
	) {
		super(plugin.app)
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

		const defaultFilename = `${this.plugin.app.vault.getName()}.${moment().format('YYYY-MM-DD HH_mm_ss')}.SyncCache`

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
							let filename = filenameInput.value
							if (!filename.endsWith('.v1')) {
								filename += '.v1'
							}
							await this.cacheService.saveCache(filename)
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
