import { App, ButtonComponent, Modal, setIcon } from 'obsidian'
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
		this.modalEl.addClass('nutstore-sync-result-modal')
		contentEl.addClass('nutstore-sync-result-modal__content')

		const container = contentEl.createDiv({
			cls: 'nutstore-sync-result',
		})
		const icon = container.createDiv({
			cls: 'nutstore-sync-result__icon',
		})
		setIcon(icon, 'circle-check-big')

		container.createEl('h2', {
			cls: 'nutstore-sync-result__title',
			text: i18n.t('sync.result.title'),
		})
		container.createEl('p', {
			cls: 'nutstore-sync-result__message',
			text: i18n.t(
				this.noChanges ? 'sync.result.noChanges' : 'sync.result.success',
			),
		})

		const actions = container.createDiv({
			cls: 'nutstore-sync-result__actions',
		})
		new ButtonComponent(actions)
			.setButtonText(i18n.t('sync.closeButton'))
			.setCta()
			.onClick(() => this.close())
	}

	onClose(): void {
		this.contentEl.empty()
		this.contentEl.removeClass('nutstore-sync-result-modal__content')
		this.modalEl.removeClass('nutstore-sync-result-modal')
		this.closeCallback?.()
	}
}
