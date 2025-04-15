import { App, Modal, Notice, Setting } from 'obsidian'
import i18n from '~/i18n'

export default class TextAreaModal extends Modal {
	constructor(
		app: App,
		private text: string,
	) {
		super(app)
	}

	onOpen() {
		const { contentEl } = this

		const textarea = contentEl.createEl('textarea', {
			cls: 'w-full h-50vh',
			text: this.text,
		})
		textarea.disabled = true

		new Setting(contentEl)
			.addButton((button) => {
				button
					.setCta()
					.setButtonText(i18n.t('textAreaModal.copy'))
					.onClick(() => {
						navigator.clipboard.writeText(this.text).then(() => {
							new Notice(i18n.t('textAreaModal.copied'))
						})
					})
			})
			.addButton((button) => {
				button.setButtonText(i18n.t('textAreaModal.close')).onClick(() => {
					this.close()
				})
			})
	}

	onClose() {
		const { contentEl } = this
		contentEl.empty()
	}
}
