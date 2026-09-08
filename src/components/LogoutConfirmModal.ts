import { App, Modal, Setting } from 'obsidian'
import i18n from '../i18n'

export default class LogoutConfirmModal extends Modal {
	private onConfirm: () => void | Promise<void>

	constructor(app: App, onConfirm: () => void | Promise<void>) {
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
			.addButton((button) => {
				button.buttonEl.addClass('mod-warning')
				button.setButtonText(i18n.t('settings.logout.confirm')).onClick(() => {
					this.close()
					void this.onConfirm()
				})
			})
	}

	onClose() {
		const { contentEl } = this
		contentEl.empty()
	}
}
