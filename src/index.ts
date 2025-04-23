import 'core-js/actual/array'
import 'core-js/actual/string/replace-all'
import './assets/styles/global.css'
import './polyfill'
import './webdav-patch'

import { LogObject } from 'consola'
import { toBase64 } from 'js-base64'
import { Notice, Plugin } from 'obsidian'
import { Subscription } from 'rxjs'
import SyncConfirmModal from './components/SyncConfirmModal'
import { SyncRibbonManager } from './components/SyncRibbonManager'
import { IN_DEV } from './consts'
import {
	emitCancelSync,
	onEndSync,
	onStartSync,
	onSyncError,
	onSyncProgress,
} from './events'
import { emitSsoReceive } from './events/sso-receive'
import i18n from './i18n'
import { ProgressService } from './services/progress.service'
import { StatusService } from './services/status.service'
import { WebDAVService } from './services/webdav.service'
import {
	DEFAULT_SETTINGS,
	NutstoreSettings,
	NutstoreSettingTab,
	setPluginInstance,
} from './settings'
import { NutstoreSync } from './sync'
import { decryptOAuthResponse } from './utils/decrypt-ticket-response'
import { is503Error } from './utils/is-503-error'
import logger from './utils/logger'
import { stdRemotePath } from './utils/std-remote-path'
import { updateLanguage } from './utils/update-language'

export default class NutstorePlugin extends Plugin {
	public isSyncing: boolean = false
	public logs: LogObject[] = []
	public progressService = new ProgressService(this)
	public ribbonManager = new SyncRibbonManager(this)
	public settings: NutstoreSettings
	public subscriptions: Subscription[] = []
	public syncStatusBar: HTMLElement
	public statusService = new StatusService(this)
	public webDAVService = new WebDAVService(this)

	async onload() {
		if (IN_DEV) {
			logger.addReporter({
				log: (logObj) => {
					this.logs.push(logObj)
				},
			})
		} else {
			logger.setReporters([
				{
					log: (logObj) => {
						this.logs.push(logObj)
					},
				},
			])
		}
		setPluginInstance(this)
		await this.loadSettings()
		await updateLanguage()
		this.registerInterval(window.setInterval(updateLanguage, 60000))
		this.addSettingTab(new NutstoreSettingTab(this.app, this))

		this.syncStatusBar = this.addStatusBarItem()
		this.syncStatusBar.addClass('nutstore-sync-status', 'hidden')

		const startSub = onStartSync().subscribe(() => {
			this.toggleSyncUI(true)
			this.statusService.updateSyncStatus({
				text: i18n.t('sync.start'),
				showNotice: true,
			})
		})

		const progressSub = onSyncProgress().subscribe((progress) => {
			const percent =
				Math.round((progress.completed.length / progress.total) * 10000) / 100
			this.statusService.updateSyncStatus({
				text: i18n.t('sync.progress', { percent }),
			})
		})

		const endSub = onEndSync().subscribe((failedCount) => {
			this.toggleSyncUI(false)
			this.statusService.updateSyncStatus({
				text:
					failedCount > 0
						? i18n.t('sync.completeWithFailed', { failedCount })
						: i18n.t('sync.complete'),
				showNotice: true,
				hideAfter: 3000,
			})
		})

		const errorSub = onSyncError().subscribe((error) => {
			this.toggleSyncUI(false)
			this.statusService.updateSyncStatus({
				text: i18n.t('sync.failedStatus'),
				isError: true,
				showNotice: false,
				hideAfter: 3000,
			})
			new Notice(
				i18n.t('sync.failedWithError', {
					error: is503Error(error)
						? i18n.t('sync.error.requestsTooFrequent')
						: error.message,
				}),
			)
		})

		this.subscriptions.push(startSub, progressSub, endSub, errorSub)

		// Add commands for starting and stopping sync
		this.addCommand({
			id: 'start-sync',
			name: i18n.t('sync.startButton'),
			callback: async () => {
				if (this.isSyncing) {
					return
				}
				const startSync = async () => {
					const sync = new NutstoreSync(this.app, {
						webdav: await this.webDAVService.createWebDAVClient(),
						vault: this.app.vault,
						token: await this.getToken(),
						remoteBaseDir: this.remoteBaseDir,
					})
					await sync.start()
				}
				new SyncConfirmModal(this.app, startSync).open()
			},
		})

		this.addCommand({
			id: 'stop-sync',
			name: i18n.t('sync.stopButton'),
			checkCallback: (checking) => {
				if (this.isSyncing) {
					if (!checking) {
						emitCancelSync()
					}
					return true
				}
				return false
			},
		})

		// Add command to show sync progress modal
		this.addCommand({
			id: 'show-sync-progress',
			name: i18n.t('sync.showProgressButton'),
			callback: () => {
				this.progressService.showProgressModal()
			},
		})

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
	}

	async onunload() {
		setPluginInstance(null)
		emitCancelSync()
		this.subscriptions.forEach((sub) => sub.unsubscribe())
		this.ribbonManager.unload()
		this.progressService.unload()
		this.statusService.unload()
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
	}

	async saveSettings() {
		await this.saveData(this.settings)
	}

	private toggleSyncUI(isSyncing: boolean) {
		this.isSyncing = isSyncing
		this.ribbonManager.update()
	}

	async createWebDAVClient() {
		return this.webDAVService.createWebDAVClient()
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
		return stdRemotePath(
			(this.settings.remoteDir || this.app.vault.getName()).trim(),
		)
	}
}
