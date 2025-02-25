import { Modal } from 'obsidian'
import i18n from '../i18n'

export class SyncModal extends Modal {
	onClose: () => void

	constructor(app: any) {
		super(app)
	}

	onOpen() {
		const { contentEl } = this
		this.contentEl = contentEl

		contentEl.createEl('h2', { text: i18n.t('sync.modalTitle') })

		const progressContainer = contentEl.createDiv({
			cls: 'sync-progress-container',
		})
		const progressBar = progressContainer.createDiv({
			cls: 'sync-progress-bar',
		})
		const progressText = contentEl.createDiv({ cls: 'sync-progress-text' })

		const cancelButton = contentEl.createEl('button', {
			text: i18n.t('sync.cancelButton'),
			cls: 'sync-cancel-button',
		})

		cancelButton.addEventListener('click', () => {
			this.onClose?.()
			this.close()
		})

		this.updateProgress = (percent: number, text: string) => {
			progressBar.style.width = `${percent}%`
			progressText.setText(`${text} (${percent}%)`)
		}
	}

	updateProgress: (percent: number, text: string) => void
}
