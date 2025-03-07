import './assets/styles/global.scss'

import { toBase64 } from 'js-base64'
import { Notice, Plugin } from 'obsidian'
import { Subscription } from 'rxjs'
import { createClient } from 'webdav'
import { SyncConfirmModal } from './components/SyncConfirmModal'
import { NS_DAV_ENDPOINT } from './consts'
import {
	emitCancelSync,
	onEndSync,
	onStartSync,
	onSyncError,
	onSyncProgress,
} from './events'
import i18n from './i18n'
import {
	DEFAULT_SETTINGS,
	NutstoreSettings,
	NutstoreSettingTab,
	setPluginInstance,
} from './settings'
import { NutstoreSync } from './sync'
import { is503Error } from './utils/is-503-error'
import { createRateLimitedWebDAVClient } from './utils/rate-limited-client'
import { stdRemotePath } from './utils/std-remote-path'
import { updateLanguage } from './utils/update-language'
import './webdav-patch'

export default class NutstorePlugin extends Plugin {
	settings: NutstoreSettings
	private syncStatusBar: HTMLElement
	private subscriptions: Subscription[] = []
	private isSyncing: boolean = false
	private ribbonIconEl: HTMLElement
	private stopSyncRibbonEl: HTMLElement
	private statusHideTimer: number | null = null

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

		if (isSyncing) {
			this.ribbonIconEl.setAttr('aria-disabled', 'true')
			this.ribbonIconEl.addClass('nutstore-sync-spinning')
			this.stopSyncRibbonEl = this.addRibbonIcon(
				'square',
				i18n.t('sync.stopButton'),
				() => emitCancelSync(),
			)
		} else {
			this.ribbonIconEl.removeAttribute('aria-disabled')
			this.ribbonIconEl.removeClass('nutstore-sync-spinning')
			if (this.stopSyncRibbonEl) {
				this.stopSyncRibbonEl.remove()
			}
		}
	}

	async onload() {
		setPluginInstance(this)
		await this.loadSettings()
		await updateLanguage()
		this.registerInterval(window.setInterval(updateLanguage, 60000))
		this.addSettingTab(new NutstoreSettingTab(this.app, this))

		this.syncStatusBar = this.addStatusBarItem()
		this.syncStatusBar.addClass('nutstore-sync-status', 'hidden')

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

		this.ribbonIconEl = this.addRibbonIcon(
			'refresh-ccw',
			i18n.t('sync.startButton'),
			async () => {
				if (this.isSyncing) {
					return
				}
				const startSync = async () => {
					const sync = new NutstoreSync({
						webdav: await this.createWebDAVClient(),
						vault: this.app.vault,
						token: await this.getToken(),
						remoteBaseDir: stdRemotePath(
							this.settings.remoteDir || this.app.vault.getName(),
						),
					})
					await sync.start()
				}
				new SyncConfirmModal(this.app, startSync).open()
			},
		)

		this.registerObsidianProtocolHandler('nutstore-sync/sso', () => {
			// TODO: save access_token
		})
	}

	async onunload() {
		setPluginInstance(null)
		emitCancelSync()
		this.subscriptions.forEach((sub) => sub.unsubscribe())
		if (this.stopSyncRibbonEl) {
			this.stopSyncRibbonEl.remove()
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
	}

	async saveSettings() {
		await this.saveData(this.settings)
	}

	async createWebDAVClient() {
		const client = createClient(NS_DAV_ENDPOINT, {
			username: this.settings.account,
			password: this.settings.credential,
		})
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

	async getToken() {
		const token = `${this.settings.account}:${this.settings.credential}`
		return toBase64(token)
	}
}
