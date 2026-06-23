import 'blob-polyfill'
import 'core-js/stable'

import './polyfill'
import './webdav-patch'

// @ts-ignore
import './assets/styles/global.css'

import { toBase64 } from 'js-base64'
import { Menu, normalizePath, Plugin } from 'obsidian'
import { createSelectedTextContextItem } from './ai/chat/context/user-context'
import { SyncRibbonManager } from './components/SyncRibbonManager'
import { emitCancelSync } from './events'
import i18n from './i18n'
import ChatService from './services/chat.service'
import CommandService from './services/command.service'
import EventsService from './services/events.service'
import GcService from './services/gc.service'
import I18nService from './services/i18n.service'
import LoggerService from './services/logger.service'
import ModelsPresetService from './services/models-preset.service'
import NutstoreLlmGatewayService from './services/nutstore-llm-gateway.service'
import { ProgressService } from './services/progress.service'
import ProtocolService from './services/protocol.service'
import RealtimeSyncService from './services/realtime-sync.service'
import ScheduledSyncService from './services/scheduled-sync.service'
import SettingsService from './services/settings.service'
import { StatusService } from './services/status.service'
import SyncExecutorService from './services/sync-executor.service'
import { WebDAVService } from './services/webdav.service'
import {
	NutstoreLocalSettings,
	NutstoreSettings,
	NutstoreSettingTab,
	setPluginInstance,
} from './settings'
import { decryptOAuthResponse } from './utils/decrypt-ticket-response'
import { stdRemotePath } from './utils/std-remote-path'
import ChatboxView, { CHATBOX_VIEW_TYPE } from './views/chatbox.view'

export default class NutstorePlugin extends Plugin {
	public isSyncing: boolean = false
	public settings!: NutstoreSettings
	public localSettings!: NutstoreLocalSettings
	public settingTab!: NutstoreSettingTab

	public commandService = new CommandService(this)
	public eventsService = new EventsService(this)
	public i18nService = new I18nService(this)
	public loggerService = new LoggerService(this)
	public modelsPresetService = new ModelsPresetService(this)
	public nutstoreLlmGatewayService = new NutstoreLlmGatewayService(this)
	public protocolService = new ProtocolService(this)
	public progressService = new ProgressService(this)
	public ribbonManager = new SyncRibbonManager(this)
	public statusService = new StatusService(this)
	public webDAVService = new WebDAVService(this)
	public settingsService = new SettingsService(this)
	public syncExecutorService = new SyncExecutorService(this)
	public gcService = new GcService(this)
	public chatService = new ChatService(this)
	public realtimeSyncService = new RealtimeSyncService(
		this,
		this.syncExecutorService,
	)
	public scheduledSyncService = new ScheduledSyncService(
		this,
		this.syncExecutorService,
	)

	async onload() {
		await this.settingsService.initialize()
		await this.chatService.initialize()
		this.settingTab = new NutstoreSettingTab(this.app, this)
		this.addSettingTab(this.settingTab)
		this.registerView(CHATBOX_VIEW_TYPE, (leaf) => new ChatboxView(leaf, this))
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor, view) => {
				if (!editor.somethingSelected()) return
				menu.addItem((item) => {
					item
						.setTitle(
							i18n.language.startsWith('zh') ? '坚果云同步' : 'Nutstore Sync',
						)
						.setIcon('cloud')
					item.setSubmenu()
					const submenu = item.submenu
					if (!submenu) return
					submenu.addItem((subItem) => {
						subItem
							.setTitle(i18n.t('chatbox.addToContext'))
							.setIcon('message-square-plus')
							.onClick(async () => {
								const sel = editor.listSelections()[0]
								if (!sel) return
								const file = (
									view as {
										file?: { path: string; basename: string } | null
									}
								).file
								if (!file) return
								this.chatService.addUserContext(
									createSelectedTextContextItem({
										type: 'selection',
										filePath: file.path,
										range: {
											from: { line: sel.anchor.line, ch: sel.anchor.ch },
											to: { line: sel.head.line, ch: sel.head.ch },
										},
										selectedText: editor.getSelection(),
									}),
								)
								const existingLeaf =
									this.app.workspace.getLeavesOfType(CHATBOX_VIEW_TYPE)[0]
								const leaf =
									existingLeaf || this.app.workspace.getRightLeaf(false)
								if (!leaf) return
								await leaf.setViewState({
									type: CHATBOX_VIEW_TYPE,
									active: true,
								})
								this.app.workspace.revealLeaf(leaf)
							})
					})
				})
			}),
		)

		setPluginInstance(this)
		await this.chatService.handleSettingsChanged()

		await this.scheduledSyncService.start()
	}

	async onunload() {
		this.settingsService.unload()
		this.app.workspace.detachLeavesOfType(CHATBOX_VIEW_TYPE)
		setPluginInstance(null)
		emitCancelSync()
		this.scheduledSyncService.unload()
		this.nutstoreLlmGatewayService.unload()
		this.progressService.unload()
		this.eventsService.unload()
		this.realtimeSyncService.unload()
		this.statusService.unload()
	}

	toggleSyncUI(isSyncing: boolean) {
		this.isSyncing = isSyncing
		this.ribbonManager.update()
	}

	async getDecryptedOAuthInfo() {
		return decryptOAuthResponse(this.settings.oauthResponseText)
	}

	async getToken() {
		let token
		if (this.settings.loginMode === 'sso') {
			let oauth
			try {
				oauth = await this.getDecryptedOAuthInfo()
			} catch {
				throw new Error(i18n.t('sync.error.ssoTokenInvalid'))
			}
			token = `${oauth.username}:${oauth.access_token}`
		} else {
			token = `${this.settings.account}:${this.settings.credential}`
		}
		return toBase64(token)
	}

	/**
	 * 检查账号配置是否完整
	 * @returns true 表示配置完整，false 表示未配置或配置不完整
	 */
	isAccountConfigured(): boolean {
		if (this.settings.loginMode === 'sso') {
			// SSO 模式：检查是否有 OAuth 响应数据
			return (
				!!this.settings.oauthResponseText &&
				this.settings.oauthResponseText.trim() !== ''
			)
		} else {
			// 手动模式：检查账号和凭证是否都已填写
			return (
				!!this.settings.account &&
				this.settings.account.trim() !== '' &&
				!!this.settings.credential &&
				this.settings.credential.trim() !== ''
			)
		}
	}

	get remoteBaseDir() {
		let remoteDir = normalizePath(this.settings.remoteDir.trim())
		if (remoteDir === '' || remoteDir === '/') {
			remoteDir = this.app.vault.getName()
		}
		return stdRemotePath(remoteDir)
	}
}
