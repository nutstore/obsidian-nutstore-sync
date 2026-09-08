import { Notice } from 'obsidian'
import { CHATBOX_AI_ICON_ID } from '~/assets/icons/obsidian-nutstore-ai-icon'
import SyncConfirmModal from '~/components/SyncConfirmModal'
import { emitCancelSync } from '~/events'
import i18n from '~/i18n'
import { type SyncPolicy } from '~/settings'
import { SyncStartMode } from '~/sync'
import logger from '~/utils/logger'
import { CHATBOX_VIEW_TYPE } from '~/views/chatbox.view'
import { BaseService } from './service.interface'
import NutstorePlugin from '..'

export default class CommandService extends BaseService {
	constructor(private plugin: NutstorePlugin) {
		super()
	}

	override onload() {
		this.plugin.addCommand({
			id: 'start-sync',
			name: i18n.t('sync.startButton'),
			icon: 'refresh-cw',
			checkCallback: (checking) => {
				if (this.plugin.isSyncing) {
					return false
				}
				if (checking) {
					return true
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

				const startSync = async (syncPolicy?: SyncPolicy) => {
					await this.plugin.syncExecutorService.executeSync({
						mode: SyncStartMode.MANUAL_SYNC,
						syncPolicy,
					})
				}
				if (this.plugin.settings.confirmBeforeSync) {
					new SyncConfirmModal(
						this.plugin.app,
						this.plugin.settings,
						this.plugin.localSettings,
						(syncPolicy) => {
							void startSync(syncPolicy)
						},
					).open()
				} else {
					void startSync()
				}
			},
		})

		this.plugin.addCommand({
			id: 'open-chatbox',
			name: i18n.t('chatbox.openCommand'),
			icon: CHATBOX_AI_ICON_ID,
			callback: () => {
				void this.openChatbox()
			},
		})

		this.plugin.addCommand({
			id: 'stop-sync',
			name: i18n.t('sync.stopButton'),
			icon: 'x-circle',
			checkCallback: (checking) => {
				if (this.plugin.isSyncing) {
					if (!checking) {
						emitCancelSync()
					}
					return true
				}
				return false
			},
		})

		this.plugin.addCommand({
			id: 'show-sync-progress',
			name: i18n.t('sync.showProgressButton'),
			icon: 'activity',
			callback: () => {
				this.plugin.progressService.showProgressModal()
			},
		})
	}

	async openChatbox() {
		const existingLeaf =
			this.plugin.app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE)[0]
		const leaf = existingLeaf || this.plugin.app.workspace.getRightLeaf(false)
		if (!leaf) return
		await leaf.setViewState({
			type: CHATBOX_VIEW_TYPE,
			active: true,
		})
		void this.plugin.app.workspace.revealLeaf(leaf)
	}
}
