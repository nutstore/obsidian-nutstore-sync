import { App, Modal, Setting } from 'obsidian'
import i18n from '~/i18n'

export default class ProviderCorsConfirmModal extends Modal {
	private confirmed = false

	constructor(app: App) {
		super(app)
	}

	onOpen() {
		const { contentEl } = this
		contentEl.empty()
		contentEl.createEl('h2', {
			text: i18n.t('settings.ai.modals.provider.corsConfirmTitle'),
		})
		contentEl.createEl('p', {
			text: i18n.t('settings.ai.modals.provider.corsConfirmMessage'),
		})

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('settings.filters.cancel'))
					.onClick(() => this.close()),
			)
			.addButton((button) =>
				button
					.setButtonText(
						i18n.t('settings.ai.modals.provider.corsConfirmEnable'),
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
