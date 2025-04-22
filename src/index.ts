import 'core-js/actual/array'
import 'core-js/actual/string/replace-all'
import './assets/styles/global.css'
import './polyfill'
import './webdav-patch'

import { LogObject } from 'consola'
import { toBase64 } from 'js-base64'
import { Notice, Plugin } from 'obsidian'
import { Subscription } from 'rxjs'
import { createClient, WebDAVClient } from 'webdav'
import SyncConfirmModal from './components/SyncConfirmModal'
import { SyncRibbonManager } from './components/SyncRibbonManager'
import { IN_DEV, NS_DAV_ENDPOINT } from './consts'
import {
	emitCancelSync,
	onEndSync,
	onStartSync,
	onSyncError,
	onSyncProgress,
} from './events'
import { emitSsoReceive } from './events/sso-receive'
import i18n from './i18n'
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
import { createRateLimitedWebDAVClient } from './utils/rate-limited-client'
import { stdRemotePath } from './utils/std-remote-path'
import { updateLanguage } from './utils/update-language'

export default class NutstorePlugin extends Plugin {
	settings: NutstoreSettings
	private syncStatusBar: HTMLElement
	private subscriptions: Subscription[] = []
	isSyncing: boolean = false
	private ribbonManager: SyncRibbonManager | undefined
	private statusHideTimer: number | null = null
	logs: LogObject[] = []

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

		this.ribbonManager = new SyncRibbonManager(this)

		const startSub = onStartSync().subscribe(() => {
			this.toggleSyncUI(true)
			this.updateSyncStatus({
				text: i18n.t('sync.start'),
				showNotice: true,
			})
		})

		const progressSub = onSyncProgress().subscribe(({ total, completed }) => {
			const percent = Math.round((completed / total) * 10000) / 100
			this.updateSyncStatus({
				text: i18n.t('sync.progress', { percent }),
			})
		})

		const endSub = onEndSync().subscribe((failedCount) => {
			this.toggleSyncUI(false)
			this.updateSyncStatus({
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
			this.updateSyncStatus({
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
						webdav: await this.createWebDAVClient(),
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
		this.ribbonManager?.unload()
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
	}

	async saveSettings() {
		await this.saveData(this.settings)
	}

	private updateSyncStatus(status: {
		text: string
		isError?: boolean
		showNotice?: boolean
		hideAfter?: number
	}) {
		if (this.statusHideTimer) {
			clearTimeout(this.statusHideTimer)
			this.statusHideTimer = null
		}

		this.syncStatusBar.setText(status.text)
		this.syncStatusBar.removeClass('hidden')

		if (status.showNotice) {
			new Notice(status.text)
		}

		if (status.hideAfter) {
			this.statusHideTimer = window.setTimeout(() => {
				this.syncStatusBar.addClass('hidden')
				this.statusHideTimer = null
			}, status.hideAfter)
		}
	}

	private toggleSyncUI(isSyncing: boolean) {
		this.isSyncing = isSyncing
		this.ribbonManager?.update()
	}

	async createWebDAVClient() {
		let client: WebDAVClient
		if (this.settings.loginMode === 'manual') {
			client = createClient(NS_DAV_ENDPOINT, {
				username: this.settings.account,
				password: this.settings.credential,
			})
		} else {
			const oauth = await this.getDecryptedOAuthInfo()
			client = createClient(NS_DAV_ENDPOINT, {
				username: oauth.username,
				password: oauth.access_token,
			})
		}
		return createRateLimitedWebDAVClient(client)
	}

	async checkWebDAVConnection(): Promise<boolean> {
		try {
			const client = await this.createWebDAVClient()
			return await client.exists('/')
		} catch (error) {
			return false
		}
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
