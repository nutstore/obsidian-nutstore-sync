import { App, Modal, Setting } from 'obsidian'
import {
	applyObsidianModalMountTarget,
	type ChatModalMountTarget,
} from '~/ai/chat/ui/modal-mount'
import i18n from '~/i18n'

export interface SessionExportOptions {
	includeToolMessages: boolean
}

export default class SessionExportModal extends Modal {
	private includeToolMessages = false
	private resolved = false

	constructor(
		app: App,
		private readonly resolve: (
			options: SessionExportOptions | undefined,
		) => void,
		private readonly mountTarget?: ChatModalMountTarget,
	) {
		super(app)
	}

	static open(app: App, mountTarget?: ChatModalMountTarget) {
		return new Promise<SessionExportOptions | undefined>((resolve) => {
			new SessionExportModal(app, resolve, mountTarget).open()
		})
	}

	onOpen() {
		const { contentEl } = this
		contentEl.empty()
		contentEl.createEl('h3', {
			text: i18n.t('chatbox.exportDialog.title'),
		})
		contentEl.createEl('p', {
			text: i18n.t('chatbox.exportDialog.description'),
		})
		new Setting(contentEl)
			.setName(i18n.t('chatbox.exportDialog.includeToolMessages'))
			.addToggle((toggle) => {
				toggle
					.setValue(this.includeToolMessages)
					.onChange((value) => (this.includeToolMessages = value))
			})

		new Setting(contentEl)
			.addButton((button) => {
				button
					.setButtonText(i18n.t('chatbox.exportDialog.cancel'))
					.onClick(() => this.close())
			})
			.addButton((button) => {
				button
					.setCta()
					.setButtonText(i18n.t('chatbox.exportDialog.confirm'))
					.onClick(() => {
						this.resolved = true
						this.resolve({
							includeToolMessages: this.includeToolMessages,
						})
						this.close()
					})
			})
	}

	onClose() {
		this.contentEl.empty()
		if (this.resolved) {
			return
		}
		this.resolve(undefined)
	}

	open() {
		super.open()
		applyObsidianModalMountTarget(this, this.mountTarget)
	}
}
