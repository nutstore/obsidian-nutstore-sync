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

	async onload() {
		await updateLanguage()
		await this.loadSettings()
		this.addSettingTab(new NutstoreSettingTab(this.app, this))

		this.syncStatusBar = this.addStatusBarItem()
		this.syncStatusBar.style.display = 'none'

		const startSub = onStartSync().subscribe(() => {
			this.isSyncing = true
			this.ribbonIconEl.setAttr('aria-disabled', 'true')
			this.ribbonIconEl.addClass('nutstore-sync-spinning')
			this.syncStatusBar.style.display = 'block'
			this.syncStatusBar.setText(i18n.t('sync.start'))
			new Notice(i18n.t('sync.start'))

			// 显示停止同步按钮
			this.stopSyncRibbonEl = this.addRibbonIcon(
				'square',
				i18n.t('sync.stopButton'),
				() => {
					emitCancelSync()
				},
			)
		})

		const progressSub = onSyncProgress().subscribe(({ total, completed }) => {
			const percent = Math.round((completed / total) * 10000) / 100
			this.syncStatusBar.setText(i18n.t('sync.progress', { percent }))
		})

		const endSub = onEndSync().subscribe((failedCount) => {
			this.isSyncing = false
			this.ribbonIconEl.removeAttribute('aria-disabled')
			this.ribbonIconEl.removeClass('nutstore-sync-spinning')
			const statusText =
				failedCount > 0
					? i18n.t('sync.completeWithFailed', { failedCount })
					: i18n.t('sync.complete')
			this.syncStatusBar.setText(statusText)
			new Notice(statusText)
			setTimeout(() => {
				this.syncStatusBar.style.display = 'none'
			}, 3000)

			// 移除停止同步按钮
			if (this.stopSyncRibbonEl) {
				this.stopSyncRibbonEl.remove()
			}
		})

		const errorSub = onSyncError().subscribe((error) => {
			this.isSyncing = false
			this.ribbonIconEl.removeAttribute('aria-disabled')
			this.ribbonIconEl.removeClass('nutstore-sync-spinning')
			this.syncStatusBar.setText(i18n.t('sync.failedStatus'))
			new Notice(i18n.t('sync.failedWithError', { error: error.message }))
			setTimeout(() => {
				this.syncStatusBar.style.display = 'none'
			}, 3000)

			// 移除停止同步按钮
			if (this.stopSyncRibbonEl) {
				this.stopSyncRibbonEl.remove()
			}
		})

		this.subscriptions.push(startSub, progressSub, endSub, errorSub)

		this.registerInterval(window.setInterval(updateLanguage, 60000))

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

		// Add CSS to style disabled button and spinning animation
		const css = document.createElement('style')
		css.id = 'nutstore-sync-styles'
		css.textContent = `
			.view-action[aria-disabled="true"] {
				opacity: 0.5;
				cursor: not-allowed;
				}
			@keyframes spin {
				from {
					transform: rotate(0deg);
				}
				to {
					transform: rotate(-360deg);
				}
			}
			.nutstore-sync-spinning {
				animation: spin 2s linear infinite;
			}
		`
		document.head.appendChild(css)

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
