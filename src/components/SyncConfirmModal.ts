import { App, Modal, Setting } from 'obsidian'
import { addClassTokens, removeClassTokens } from '~/utils/class-tokens'
import i18n from '../i18n'
import {
	getConflictStrategyI18nKey,
	getSyncPolicyDescI18nKey,
	getSyncPolicyNameI18nKey,
	SyncPolicy,
	type NutstoreLocalSettings,
	type NutstoreSettings,
} from '../settings'

export default class SyncConfirmModal extends Modal {
	private selectedPolicy: SyncPolicy

	constructor(
		app: App,
		private settings: NutstoreSettings,
		localSettings: NutstoreLocalSettings,
		private onConfirm: (policy: SyncPolicy) => void,
	) {
		super(app)
		this.selectedPolicy = localSettings.syncPolicy
	}

	async onOpen() {
		this.setTitle(i18n.t('sync.confirmModal.title'))

		const { contentEl } = this
		addClassTokens(this.modalEl, ':uno: sync-confirm-modal')
		addClassTokens(contentEl, ':uno: sync-confirm-modal__content')
		const bodyEl = contentEl.createDiv({
			cls: ':uno: min-h-0 flex-1 overflow-y-auto',
		})
		const footerEl = contentEl.createDiv({
			cls: ':uno: sync-confirm-modal__footer',
		})

		const infoDiv = bodyEl.createDiv({ cls: ':uno: sync-info' })
		infoDiv.createEl('p', {
			text: i18n.t('sync.confirmModal.remoteDir', {
				dir: this.settings.remoteDir,
			}),
		})
		const conflictStrategyInfo = infoDiv.createEl('p')

		bodyEl.createEl('h3', {
			text: i18n.t('sync.confirmModal.policyTitle'),
		})

		const policySection = bodyEl.createEl('section')
		const policyOptions = policySection.createDiv({
			cls: ':uno: grid gap-1.5 my-3',
		})
		const policyDescription = policySection.createEl('pre', {
			cls: ':uno: mt-0 whitespace-pre-wrap',
		})
		const updatePolicyDescription = () => {
			policyDescription.setText(
				[
					i18n.t('sync.confirmModal.policyBasis'),
					i18n.t(getSyncPolicyDescI18nKey(this.selectedPolicy)),
					i18n.t('sync.confirmModal.policyRecordNote'),
				].join('\n\n'),
			)
			if (this.selectedPolicy === SyncPolicy.TwoWay) {
				conflictStrategyInfo.setText(
					i18n.t('sync.confirmModal.strategy', {
						strategy: i18n.t(
							`settings.conflictStrategy.${getConflictStrategyI18nKey(this.settings.conflictStrategy)}`,
						),
					}),
				)
				conflictStrategyInfo.hidden = false
			} else {
				conflictStrategyInfo.hidden = true
			}
		}

		for (const policy of Object.values(SyncPolicy)) {
			const option = policyOptions.createEl('label', {
				cls: ':uno: flex items-center gap-2 cursor-pointer',
			})
			const radio = option.createEl('input', {
				type: 'radio',
				value: policy,
				attr: { name: 'nutstore-sync-policy' },
			})
			radio.checked = policy === this.selectedPolicy
			radio.addEventListener('change', () => {
				if (!radio.checked) {
					return
				}
				this.selectedPolicy = policy
				updatePolicyDescription()
			})
			option.createSpan({
				text: i18n.t(getSyncPolicyNameI18nKey(policy)),
			})
		}
		updatePolicyDescription()
		bodyEl.createEl('pre', {
			cls: ':uno: whitespace-pre-wrap',
			text: i18n.t('sync.confirmModal.message'),
		})

		new Setting(footerEl)
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
						this.onConfirm(this.selectedPolicy)
					}),
			)
	}

	onClose() {
		const { contentEl } = this
		contentEl.empty()
		removeClassTokens(contentEl, ':uno: sync-confirm-modal__content')
		removeClassTokens(this.modalEl, ':uno: sync-confirm-modal')
	}
}
