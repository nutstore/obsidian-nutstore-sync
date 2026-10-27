import { App, Modal, Setting } from 'obsidian'
import i18n from '~/i18n'
import { getSyncPolicyNameI18nKey, SyncPolicy } from '~/settings'
import { renderSyncPolicyRules } from './sync-policy-rules'

export default class SyncPolicyModal extends Modal {
	private policy: SyncPolicy
	private resolve: (confirmed: boolean) => void = () => {}
	private settled = false

	constructor(app: App, policy: SyncPolicy) {
		super(app)
		this.policy = policy
	}

	openAndWait(): Promise<boolean> {
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
		this.setTitle(i18n.t('settings.syncPolicy.modal.title'))

		const { contentEl } = this

		contentEl.createEl('p', {
			text: i18n.t(getSyncPolicyNameI18nKey(this.policy)),
		})
		renderSyncPolicyRules(contentEl.createDiv(), this.policy)

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
