import 'blob-polyfill'
import 'core-js/stable'

import './polyfill'
import './webdav-patch'

import './assets/styles/global.css'

import { toBase64 } from 'js-base64'
import { normalizePath, Notice, Plugin } from 'obsidian'
import { SyncRibbonManager } from './components/SyncRibbonManager'
import { emitCancelSync } from './events'
import { emitSsoReceive } from './events/sso-receive'
import i18n from './i18n'
import ScheduledSyncService from './services/scheduled-sync.service'
import CommandService from './services/command.service'
import EventsService from './services/events.service'
import I18nService from './services/i18n.service'
import LoggerService from './services/logger.service'
import { ProgressService } from './services/progress.service'
import RealtimeSyncService from './services/realtime-sync.service'
import { StatusService } from './services/status.service'
import SyncExecutorService from './services/sync-executor.service'
import { WebDAVService } from './services/webdav.service'
import {
	NutstoreSettings,
	NutstoreSettingTab,
	setPluginInstance,
	SyncMode,
} from './settings'
import { ConflictStrategy } from './sync/tasks/conflict-resolve.task'
import { decryptOAuthResponse } from './utils/decrypt-ticket-response'
import { GlobMatchOptions } from './utils/glob-match'
import { stdRemotePath } from './utils/std-remote-path'

export default class NutstorePlugin extends Plugin {
	public isSyncing: boolean = false
	public settings: NutstoreSettings

	public commandService = new CommandService(this)
	public eventsService = new EventsService(this)
	public i18nService = new I18nService(this)
	public loggerService = new LoggerService(this)
	public progressService = new ProgressService(this)
	public ribbonManager = new SyncRibbonManager(this)
	public statusService = new StatusService(this)
	public webDAVService = new WebDAVService(this)
	public syncExecutorService = new SyncExecutorService(this)
	public realtimeSyncService = new RealtimeSyncService(
		this,
		this.syncExecutorService,
	)
	public scheduledSyncService = new ScheduledSyncService(this, this.syncExecutorService)

	async onload() {
		await this.loadSettings()
		this.addSettingTab(new NutstoreSettingTab(this.app, this))

		this.registerObsidianProtocolHandler('nutstore-sync/sso', async (data) => {
			if (data?.s) {
				this.settings.oauthResponseText = data.s
				await this.saveSettings()
				new Notice(i18n.t('settings.login.success'), 5000)
			}
			emitSsoReceive({
				token: data?.s,
			})
		})
		setPluginInstance(this)

		await this.scheduledSyncService.start()
	}

	async onunload() {
		setPluginInstance(null)
		emitCancelSync()
		this.scheduledSyncService.unload()
		this.progressService.unload()
		this.eventsService.unload()
		this.realtimeSyncService.unload()
		this.statusService.unload()
	}

	async loadSettings() {
		function createGlobMathOptions(expr: string) {
			return {
				expr,
				options: {
					caseSensitive: false,
				},
			} satisfies GlobMatchOptions
		}
		const DEFAULT_SETTINGS: NutstoreSettings = {
			account: '',
			credential: '',
			remoteDir: '',
			remoteCacheDir: '',
			useGitStyle: false,
			conflictStrategy: ConflictStrategy.DiffMatchPatch,
			oauthResponseText: '',
			loginMode: 'sso',
			confirmBeforeSync: true,
			confirmBeforeDeleteInAutoSync: true,
			syncMode: SyncMode.LOOSE,
			filterRules: {
				exclusionRules: [
					'**/.git',
					'**/.DS_Store',
					'**/.trash',
					this.app.vault.configDir,
				].map(createGlobMathOptions),
				inclusionRules: [],
			},
			skipLargeFiles: {
				maxSize: '30 MB',
			},
			realtimeSync: false,
			startupSyncDelaySeconds: 0,
			autoSyncIntervalSeconds: 300,
			language: undefined,
		}

		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
	}

	async saveSettings() {
		await this.saveData(this.settings)
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
			const oauth = await this.getDecryptedOAuthInfo()
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
			return !!this.settings.oauthResponseText && this.settings.oauthResponseText.trim() !== ''
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
