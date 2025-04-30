import 'core-js/actual/array'
import 'core-js/actual/string/pad-start'
import 'core-js/actual/string/replace-all'
import './assets/styles/global.css'
import './polyfill'
import './webdav-patch'

import { toBase64 } from 'js-base64'
import { normalizePath, Notice, Plugin } from 'obsidian'
import { SyncRibbonManager } from './components/SyncRibbonManager'
import { emitCancelSync } from './events'
import { emitSsoReceive } from './events/sso-receive'
import i18n from './i18n'
import CommandService from './services/command.service'
import EventsService from './services/events.service'
import I18nService from './services/i18n.service'
import LoggerService from './services/logger.service'
import { ProgressService } from './services/progress.service'
import RealtimeSyncService from './services/realtime-sync.service'
import { StatusService } from './services/status.service'
import { WebDAVService } from './services/webdav.service'
import {
	NutstoreSettings,
	NutstoreSettingTab,
	setPluginInstance,
	SyncMode,
} from './settings'
import { decryptOAuthResponse } from './utils/decrypt-ticket-response'
import { stdRemotePath } from './utils/std-remote-path'

export default class NutstorePlugin extends Plugin {
	public isSyncing: boolean = false
	public lastSyncAt: number = -Infinity
	public settings: NutstoreSettings

	public commandService = new CommandService(this)
	public eventsService = new EventsService(this)
	public i18nService = new I18nService(this)
	public loggerService = new LoggerService(this)
	public progressService = new ProgressService(this)
	public ribbonManager = new SyncRibbonManager(this)
	public statusService = new StatusService(this)
	public webDAVService = new WebDAVService(this)
	public realtimeSyncService = new RealtimeSyncService(this)

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
	}

	async onunload() {
		setPluginInstance(null)
		emitCancelSync()
		this.ribbonManager.unload()
		this.progressService.unload()
		this.statusService.unload()
		this.eventsService.unload()
	}

	async loadSettings() {
		const DEFAULT_SETTINGS: NutstoreSettings = {
			account: '',
			credential: '',
			remoteDir: '',
			remoteCacheDir: '',
			useGitStyle: false,
			conflictStrategy: 'diff-match-patch',
			oauthResponseText: '',
			loginMode: 'sso',
			confirmBeforeSync: true,
			syncMode: SyncMode.LOOSE,
			filters: ['.git', '.DS_Store', '.Trash', this.app.vault.configDir],
			skipLargeFiles: {
				maxSize: '30 MB',
			},
			realtimeSync: false,
		}

		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
	}

	async saveSettings() {
		await this.saveData(this.settings)
	}

	toggleSyncUI(isSyncing: boolean) {
		this.isSyncing = isSyncing
		if (!isSyncing) {
			this.lastSyncAt = Date.now()
		}
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

	get remoteBaseDir() {
		let remoteDir = normalizePath(this.settings.remoteDir.trim())
		if (remoteDir === '' || remoteDir === '/') {
			remoteDir = this.app.vault.getName()
		}
		return stdRemotePath(remoteDir)
	}
}
