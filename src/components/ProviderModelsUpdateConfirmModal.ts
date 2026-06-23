import { App, Modal, Setting } from 'obsidian'
import { AIModelConfig, AIProviderConfig } from '~/ai/core/types'
import i18n from '~/i18n'

export default class ProviderModelsUpdateConfirmModal extends Modal {
	private confirmed = false

	constructor(
		app: App,
		private provider: AIProviderConfig,
		private models: AIModelConfig[],
	) {
		super(app)
	}

	onOpen() {
		const { contentEl } = this
		contentEl.empty()
		contentEl.createEl('h2', {
			text: i18n.t('settings.ai.modals.providers.updateModelsTitle'),
		})
		contentEl.createEl('p', {
			text: i18n.t('settings.ai.modals.providers.updateModelsDesc', {
				provider: this.provider.name || this.provider.id,
				count: this.models.length,
			}),
		})

		const listEl = contentEl.createEl('ul', {
			cls: 'max-h-50vh overflow-y-auto',
		})
		for (const model of this.models) {
			const itemEl = listEl.createEl('li')
			itemEl.createSpan({
				text: model.name && model.name !== model.id ? `${model.name} ` : '',
			})
			itemEl.createEl('code', { text: model.id })
		}

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('settings.filters.cancel'))
					.onClick(() => this.close()),
			)
			.addButton((button) =>
				button
					.setButtonText(
						i18n.t('settings.ai.modals.providers.updateModelsConfirm'),
					)
					.setCta()
					.onClick(() => {
						this.confirmed = true
						this.close()
					}),
			)
	}

	async open(): Promise<boolean> {
		super.open()
		return new Promise((resolve) => {
			const originalOnClose = this.onClose.bind(this)
			this.onClose = () => {
				originalOnClose()
				resolve(this.confirmed)
			}
		})
	}

	onClose() {
		this.contentEl.empty()
	}
}
