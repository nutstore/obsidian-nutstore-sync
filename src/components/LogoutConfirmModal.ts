import { App, Modal, Setting } from 'obsidian'
import i18n from '../i18n'

export class LogoutConfirmModal extends Modal {
	private onConfirm: () => void

	constructor(app: App, onConfirm: () => void) {
		super(app)
		this.onConfirm = onConfirm
	}

	onOpen() {
		const { contentEl } = this

		contentEl.createEl('h2', { text: i18n.t('settings.logout.confirmTitle') })
		contentEl.createEl('p', { text: i18n.t('settings.logout.confirmMessage') })

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('settings.logout.cancel'))
					.onClick(() => this.close()),
			)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('settings.logout.confirm'))
					.setWarning()
					.onClick(() => {
						this.close()
						this.onConfirm()
					}),
			)
	}

	onClose() {
		const { contentEl } = this
		contentEl.empty()
	}
}
