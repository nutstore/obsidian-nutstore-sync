import { App, Modal, Setting } from 'obsidian'
import i18n from '~/i18n'
import { getSyncPolicyDescI18nKey, SyncPolicy } from '~/settings'

export default class SyncPolicyModal extends Modal {
	private policy: SyncPolicy
	private resolve: (confirmed: boolean) => void = () => {}
	private settled = false

	constructor(app: App, policy: SyncPolicy) {
		super(app)
		this.policy = policy
	}

	open(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve
			super.open()
		})
	}

	private settle(confirmed: boolean) {
		if (this.settled) return
		this.settled = true
		this.resolve(confirmed)
	}

	onOpen() {
		const { contentEl } = this
		contentEl.createEl('h2', {
			text: i18n.t('settings.syncPolicy.modal.title'),
		})

		const desc = i18n.t(getSyncPolicyDescI18nKey(this.policy))

		const preEl = contentEl.createEl('pre', { text: desc })
		preEl.style.whiteSpace = 'pre-wrap'

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText(i18n.t('settings.syncPolicy.modal.cancel'))
					.onClick(() => {
						this.settle(false)
						this.close()
					}),
			)
			.addButton((btn) =>
				btn
					.setButtonText(i18n.t('settings.syncPolicy.modal.confirm'))
					.setCta()
					.onClick(() => {
						this.settle(true)
						this.close()
					}),
			)
	}

	onClose() {
		this.settle(false)
		this.contentEl.empty()
	}
}
