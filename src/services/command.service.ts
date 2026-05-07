import { Notice } from 'obsidian'
import SyncConfirmModal from '~/components/SyncConfirmModal'
import { emitCancelSync } from '~/events'
import i18n from '~/i18n'
import { SyncStartMode } from '~/sync'
import logger from '~/utils/logger'
import { CHATBOX_VIEW_TYPE } from '~/views/chatbox.view'
import NutstorePlugin from '..'

export default class CommandService {
	constructor(plugin: NutstorePlugin) {
		plugin.addCommand({
			id: 'start-sync',
			name: i18n.t('sync.startButton'),
			icon: 'refresh-cw',
			checkCallback: (checking) => {
				if (plugin.isSyncing) {
					return false
				}
				if (checking) {
					return true
				}

				// 检查账号配置
				if (!plugin.isAccountConfigured()) {
					new Notice(i18n.t('sync.error.accountNotConfigured'))
					// 打开设置页面，引导用户配置账号
					try {
						const setting = plugin.app.setting
						if (setting) {
							setting.open()
							setting.openTabById(plugin.manifest.id)
						}
					} catch (error) {
						logger.error('Failed to open settings:', error)
					}
					return
				}

				const startSync = async () => {
					await plugin.syncExecutorService.executeSync({
						mode: SyncStartMode.MANUAL_SYNC,
					})
				}
				if (plugin.settings.confirmBeforeSync) {
					new SyncConfirmModal(plugin.app, startSync).open()
				} else {
					startSync()
				}
			},
		})

		plugin.addCommand({
			id: 'open-chatbox',
			name: i18n.t('chatbox.openCommand'),
			icon: 'bot',
			callback: async () => {
				const existingLeaf =
					plugin.app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE)[0]
				const leaf = existingLeaf || plugin.app.workspace.getRightLeaf(false)
				if (!leaf) {
					return
				}
				await leaf.setViewState({
					type: CHATBOX_VIEW_TYPE,
					active: true,
				})
				plugin.app.workspace.revealLeaf(leaf)
			},
		})

		plugin.addCommand({
			id: 'stop-sync',
			name: i18n.t('sync.stopButton'),
			icon: 'x-circle',
			checkCallback: (checking) => {
				if (plugin.isSyncing) {
					if (!checking) {
						emitCancelSync()
					}
					return true
				}
				return false
			},
		})

		plugin.addCommand({
			id: 'show-sync-progress',
			name: i18n.t('sync.showProgressButton'),
			icon: 'activity',
			callback: () => {
				plugin.progressService.showProgressModal()
			},
		})
	}
}
