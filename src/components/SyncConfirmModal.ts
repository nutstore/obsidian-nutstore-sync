import { App, Modal, Setting } from 'obsidian'
import i18n from '../i18n'
import { SyncPolicy, useLocalSettings, useSettings } from '../settings'

export default class SyncConfirmModal extends Modal {
	private onConfirm: () => void

	constructor(app: App, onConfirm: () => void) {
		super(app)
		this.onConfirm = onConfirm
	}

	async onOpen() {
		const { contentEl } = this
		const settings = await useSettings()
		const localSettings = await useLocalSettings()

		const policy = localSettings.syncPolicy

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
		infoDiv.createEl('p', {
			text: i18n.t('sync.confirmModal.policy', {
				policy: i18n.t(
					`settings.syncPolicy.${policy === SyncPolicy.LocalMirror ? 'localMirror' : policy === SyncPolicy.RemoteMirror ? 'remoteMirror' : 'bidirectional'}`,
				),
			}),
		})
		if (policy === SyncPolicy.LocalMirror) {
			contentEl.createEl('pre', {
				text: i18n.t('settings.syncPolicy.modal.localMirrorDesc'),
			}).style.whiteSpace = 'pre-wrap'
		} else if (policy === SyncPolicy.RemoteMirror) {
			contentEl.createEl('pre', {
				text: i18n.t('settings.syncPolicy.modal.remoteMirrorDesc'),
			}).style.whiteSpace = 'pre-wrap'
		} else {
			contentEl.createEl('pre', {
				text: i18n.t('settings.syncPolicy.modal.bidirectionalDesc'),
			}).style.whiteSpace = 'pre-wrap'
		}
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
						this.onConfirm()
					}),
			)
	}

	onClose() {
		const { contentEl } = this
		contentEl.empty()
	}
}
