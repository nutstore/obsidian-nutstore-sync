import { App, Modal, Setting } from 'obsidian'
import i18n from '../i18n'
import { useSettings } from '../settings'

export default class SyncConfirmModal extends Modal {
	private onConfirm: () => void

	constructor(app: App, onConfirm: () => void) {
		super(app)
		this.onConfirm = onConfirm
	}

	onOpen() {
		const { contentEl } = this
		const settings = useSettings()

		contentEl.createEl('h2', { text: i18n.t('sync.confirmModal.title') })
		const infoDiv = contentEl.createDiv({ cls: 'sync-info' })
		infoDiv.createEl('p', {
			text: i18n.t('sync.confirmModal.remoteDir', { dir: settings.remoteDir }),
		})
		infoDiv.createEl('p', {
			text: i18n.t('sync.confirmModal.strategy', {
				strategy: i18n.t(
					`settings.conflictStrategy.${settings.conflictStrategy === 'diff-match-patch' ? 'diffMatchPatch' : 'latestTimestamp'}`,
				),
			}),
		})
		contentEl.createEl('pre', { text: i18n.t('sync.confirmModal.message') })

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('sync.confirmModal.cancel'))
					.onClick(() => this.close()),
			)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('sync.confirmModal.confirm'))
					.setCta()
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
