import { Notice } from 'obsidian'
import logger from '~/utils/logger'
import { emitCancelSync } from '../events'
import i18n from '../i18n'
import type NutstorePlugin from '../index'
import { SyncStartMode } from '../sync'
import { CHATBOX_VIEW_TYPE } from '../views/chatbox.view'
import SyncConfirmModal from './SyncConfirmModal'

export class SyncRibbonManager {
	private startRibbonEl: HTMLElement
	private stopRibbonEl: HTMLElement

	constructor(private plugin: NutstorePlugin) {
		this.startRibbonEl = this.plugin.addRibbonIcon(
			'refresh-ccw',
			i18n.t('sync.startButton'),
			async () => {
				if (this.plugin.isSyncing) {
					return
				}

				// 检查账号配置
				if (!this.plugin.isAccountConfigured()) {
					new Notice(i18n.t('sync.error.accountNotConfigured'))
					// 打开设置页面，引导用户配置账号
					try {
						const setting = this.plugin.app.setting
						if (setting) {
							setting.open()
							setting.openTabById(this.plugin.manifest.id)
						}
					} catch (error) {
						logger.error('Failed to open settings:', error)
					}
					return
				}

				const startSync = async () => {
					await this.plugin.syncExecutorService.executeSync({
						mode: SyncStartMode.MANUAL_SYNC,
					})
				}
				if (plugin.settings.confirmBeforeSync) {
					new SyncConfirmModal(this.plugin.app, startSync).open()
				} else {
					startSync()
				}
			},
		)

		this.stopRibbonEl = this.plugin.addRibbonIcon(
			'square',
			i18n.t('sync.stopButton'),
			() => emitCancelSync(),
		)
		this.stopRibbonEl.classList.add('hidden')

		this.plugin.addRibbonIcon(
			'bot',
			i18n.t('chatbox.openCommand'),
			async () => {
				const existingLeaf =
					this.plugin.app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE)[0]
				const leaf =
					existingLeaf || this.plugin.app.workspace.getRightLeaf(false)
				if (!leaf) {
					return
				}
				await leaf.setViewState({ type: CHATBOX_VIEW_TYPE, active: true })
				this.plugin.app.workspace.revealLeaf(leaf)
			},
		)
	}

	public update() {
		if (this.plugin.isSyncing) {
			this.startRibbonEl.setAttr('aria-disabled', 'true')
			this.startRibbonEl.addClass('nutstore-sync-spinning')
			this.stopRibbonEl.classList.remove('hidden')
		} else {
			this.startRibbonEl.removeAttribute('aria-disabled')
			this.startRibbonEl.removeClass('nutstore-sync-spinning')
			this.stopRibbonEl.classList.add('hidden')
		}
	}
}
