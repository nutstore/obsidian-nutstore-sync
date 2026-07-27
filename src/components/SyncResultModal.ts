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
			cls: ':uno: flex flex-col items-center text-center pt-8 pb-6 px-7',
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
			cls: ':uno: flex justify-center w-full mt-6',
		})
		const btn = new ButtonComponent(actions)
			.setButtonText(i18n.t('sync.closeButton'))
			.setCta()
			.onClick(() => this.close())
		btn.buttonEl.classList.add(':uno: min-w-24')
	}

	onClose(): void {
		this.contentEl.empty()
		this.contentEl.removeClass('nutstore-sync-result-modal__content')
		this.modalEl.removeClass('nutstore-sync-result-modal')
		this.closeCallback?.()
	}
}
