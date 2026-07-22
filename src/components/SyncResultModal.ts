import { App, Modal, Setting, setIcon } from 'obsidian'
import i18n from '~/i18n'

export default class SyncResultModal extends Modal {
	constructor(
		app: App,
		private noChanges: boolean,
		private closeCallback?: () => void,
	) {
		super(app)
	}

	onOpen(): void {
		const { contentEl } = this
		contentEl.empty()

		const container = contentEl.createDiv({
			cls: 'flex flex-col items-center gap-4 py-6 text-center',
		})
		const icon = container.createDiv({
			cls: 'text-[var(--text-success)]',
		})
		setIcon(icon, 'circle-check-big')
		const svg = icon.querySelector('svg')
		svg?.setAttribute('width', '64')
		svg?.setAttribute('height', '64')

		container.createEl('h2', {
			cls: 'm-0',
			text: i18n.t('sync.result.title'),
		})
		container.createEl('p', {
			cls: 'm-0 text-[var(--text-muted)]',
			text: i18n.t(
				this.noChanges ? 'sync.result.noChanges' : 'sync.result.success',
			),
		})

		new Setting(container).addButton((button) =>
			button
				.setButtonText(i18n.t('sync.closeButton'))
				.setCta()
				.onClick(() => this.close()),
		)
	}

	onClose(): void {
		this.contentEl.empty()
		this.closeCallback?.()
	}
}
