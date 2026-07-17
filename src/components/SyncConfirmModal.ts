import { App, Modal, Setting } from 'obsidian'
import i18n from '../i18n'
import {
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
		const { contentEl } = this

		contentEl.createEl('h2', { text: i18n.t('sync.confirmModal.title') })
		const infoDiv = contentEl.createDiv({ cls: 'sync-info' })
		infoDiv.createEl('p', {
			text: i18n.t('sync.confirmModal.remoteDir', {
				dir: this.settings.remoteDir,
			}),
		})
		infoDiv.createEl('p', {
			text: i18n.t('sync.confirmModal.strategy', {
				strategy: i18n.t(
					`settings.conflictStrategy.${this.settings.conflictStrategy === 'diff-match-patch' ? 'diffMatchPatch' : 'latestTimestamp'}`,
				),
			}),
		})

		contentEl.createEl('h3', {
			text: i18n.t('sync.confirmModal.policyTitle'),
		})

		const policySection = contentEl.createEl('section')
		const policyOptions = policySection.createDiv({ cls: 'grid gap-1.5 my-3' })
		const policyDescription = policySection.createEl('pre', {
			cls: 'mt-0',
		})
		policyDescription.style.whiteSpace = 'pre-wrap'
		const updatePolicyDescription = () => {
			policyDescription.setText(
				i18n.t(getSyncPolicyDescI18nKey(this.selectedPolicy)),
			)
		}

		for (const policy of Object.values(SyncPolicy)) {
			const option = policyOptions.createEl('label', {
				cls: 'flex items-center gap-2 cursor-pointer',
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
		contentEl.createEl('pre', {
			text: i18n.t('sync.confirmModal.message'),
		}).style.whiteSpace = 'pre-wrap'

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
						this.onConfirm(this.selectedPolicy)
					}),
			)
	}

	onClose() {
		const { contentEl } = this
		contentEl.empty()
	}
}
