import { toBase64 } from 'js-base64'
import { Notice, Plugin } from 'obsidian'
import { Subscription } from 'rxjs'
import { createClient } from 'webdav'
import { DAV_API } from './consts'
import {
	emitCancelSync,
	onEndSync,
	onStartSync,
	onSyncError,
	onSyncProgress,
} from './events'
import i18n from './i18n'
import { NutstoreSettingTab } from './settings'
import { NutStoreSync } from './sync'
import { createRateLimitedWebDAVClient } from './utils/rate-limited-client'
import { stdRemotePath } from './utils/std-remote-path'
import { updateLanguage } from './utils/update-language'
import './webdav-patch'

interface MyPluginSettings {
	account: string
	credential: string
	remoteDir: string
	accessToken: string
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	account: '',
	credential: '',
	remoteDir: '',
	accessToken: '',
}

export default class NutStorePlugin extends Plugin {
	settings: MyPluginSettings
	private syncStatusBar: HTMLElement
	private subscriptions: Subscription[] = []
	private isSyncing: boolean = false
	private ribbonIconEl: HTMLElement
	private stopSyncRibbonEl: HTMLElement
	private statusHideTimer: NodeJS.Timeout | null = null

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
			this.statusHideTimer = setTimeout(() => {
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
				showNotice: true,
				hideAfter: 3000,
			})
			new Notice(i18n.t('sync.failedWithError', { error: error.message }))
		})

		this.subscriptions.push(startSub, progressSub, endSub, errorSub)

		this.ribbonIconEl = this.addRibbonIcon(
			'refresh-ccw',
			i18n.t('sync.startButton'),
			async () => {
				if (this.isSyncing) {
					return
				}
				const sync = new NutStoreSync({
					webdav: this.createWebDAVClient(),
					vault: this.app.vault,
					token: toBase64(
						`${this.settings.account}:${this.settings.credential}`,
					),
					remoteBaseDir: stdRemotePath(
						this.settings.remoteDir || this.app.vault.getName(),
					),
				})
				await sync.start()
			},
		)

		this.registerObsidianProtocolHandler('nutstore-sync/sso', () => {
			// TODO: save access_token
		})
	}

	async onunload() {
		emitCancelSync()
		this.subscriptions.forEach((sub) => sub.unsubscribe())
		const styleEl = document.getElementById('nutstore-sync-styles')
		if (styleEl) {
			styleEl.remove()
		}
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

	createWebDAVClient() {
		const client = createClient(DAV_API, {
			username: this.settings.account,
			password: this.settings.credential,
		})
		return createRateLimitedWebDAVClient(client)
	}

	async checkWebDAVConnection(): Promise<boolean> {
		try {
			const client = this.createWebDAVClient()
			return await client.exists('/')
		} catch (error) {
			return false
		}
	}
}
