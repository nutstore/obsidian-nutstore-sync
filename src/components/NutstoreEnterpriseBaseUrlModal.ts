import { Modal, Notice, Setting } from 'obsidian'
import i18n from '~/i18n'
import {
	NutstoreBaseUrlValidationError,
	normalizeNutstoreBaseUrl,
} from '~/utils/nutstore-endpoints'
import type NutstorePlugin from '..'

export default class NutstoreEnterpriseBaseUrlModal extends Modal {
	constructor(private plugin: NutstorePlugin) {
		super(plugin.app)
	}

	onOpen() {
		const { contentEl } = this
		let value = this.plugin.settings.nutstoreEnterpriseBaseUrl

		contentEl.createEl('h2', {
			text: i18n.t('settings.enterpriseBaseUrl.modalTitle'),
		})

		new Setting(contentEl)
			.setName(i18n.t('settings.enterpriseBaseUrl.name'))
			.setDesc(i18n.t('settings.enterpriseBaseUrl.desc'))
			.addText((text) => {
				text
					.setPlaceholder(i18n.t('settings.enterpriseBaseUrl.placeholder'))
					.setValue(value)
					.onChange((nextValue) => {
						value = nextValue
					})
				text.inputEl.addEventListener('keydown', (event) => {
					if (event.key === 'Enter') {
						event.preventDefault()
						void this.save(value)
					}
				})
			})

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setCta()
					.setButtonText(i18n.t('settings.filters.save'))
					.onClick(() => {
						void this.save(value)
					}),
			)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('settings.filters.cancel'))
					.onClick(() => this.close()),
			)
	}

	private async save(value: string) {
		const trimmed = value.trim()
		if (!trimmed) {
			this.plugin.settings.nutstoreEnterpriseBaseUrl = ''
			await this.plugin.settingsService.saveSettings()
			await this.plugin.settingTab?.rerenderIfVisible()
			this.close()
			return
		}

		try {
			this.plugin.settings.nutstoreEnterpriseBaseUrl =
				normalizeNutstoreBaseUrl(trimmed)
			await this.plugin.settingsService.saveSettings()
			await this.plugin.settingTab?.rerenderIfVisible()
			this.close()
		} catch (error) {
			const reason =
				error instanceof NutstoreBaseUrlValidationError
					? i18n.t(`settings.enterpriseBaseUrl.errors.${error.reason}`)
					: i18n.t('settings.enterpriseBaseUrl.errors.invalidFormat')
			new Notice(
				i18n.t('settings.enterpriseBaseUrl.invalidWithReason', {
					reason,
				}),
			)
		}
	}

	onClose() {
		this.contentEl.empty()
	}
}
