import { App, Modal, Setting } from 'obsidian'
import i18n from '~/i18n'

export default class NutstoreLlmGatewayBetaConfirmModal extends Modal {
	constructor(
		app: App,
		private onConfirm: () => void,
	) {
		super(app)
	}

	onOpen() {
		const { contentEl } = this
		contentEl.createEl('h2', {
			text: i18n.t('settings.ai.nutstoreLlmGateway.betaModal.title'),
		})
		contentEl.createEl('p', {
			text: i18n.t('settings.ai.nutstoreLlmGateway.betaModal.message'),
		})
		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText(
						i18n.t('settings.ai.nutstoreLlmGateway.betaModal.cancel'),
					)
					.onClick(() => this.close()),
			)
			.addButton((button) =>
				button
					.setButtonText(
						i18n.t('settings.ai.nutstoreLlmGateway.betaModal.confirm'),
					)
					.setCta()
					.onClick(() => {
						this.close()
						this.onConfirm()
					}),
			)
	}

	onClose() {
		this.contentEl.empty()
	}
}
