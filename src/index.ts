import { toBase64 } from 'js-base64'
import { Notice, Plugin } from 'obsidian'
import { createClient } from 'webdav'
import { DAV_API } from './consts'
import { onEndSync, onStartSync, onSyncError, onSyncProgress } from './events'
import i18n from './i18n'
import { NutstoreSettingTab } from './settings'
import { NutStoreSync } from './sync'
import { stdRemotePath } from './utils/std-remote-path'
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
	private subscriptions: (() => void)[] = []

	async onload() {
		await this.loadSettings()
		this.updateLanguage()
		this.addSettingTab(new NutstoreSettingTab(this.app, this))

		this.syncStatusBar = this.addStatusBarItem()
		this.syncStatusBar.style.display = 'none'

		const startSub = onStartSync().subscribe(() => {
			this.syncStatusBar.style.display = 'block'
			this.syncStatusBar.setText(i18n.t('sync.start'))
			new Notice(i18n.t('sync.start'))
		})

		const progressSub = onSyncProgress().subscribe(({ total, completed }) => {
			this.syncStatusBar.setText(i18n.t('sync.progress', { completed, total }))
		})

		const endSub = onEndSync().subscribe(() => {
			this.syncStatusBar.setText(i18n.t('sync.complete'))
			new Notice(i18n.t('sync.complete'))
			setTimeout(() => {
				this.syncStatusBar.style.display = 'none'
			}, 3000)
		})

		const errorSub = onSyncError().subscribe((error) => {
			this.syncStatusBar.setText(i18n.t('sync.failedStatus'))
			new Notice(i18n.t('sync.failedWithError', { error: error.message }))
			setTimeout(() => {
				this.syncStatusBar.style.display = 'none'
			}, 3000)
		})

		this.subscriptions.push(
			() => startSub.unsubscribe(),
			() => progressSub.unsubscribe(),
			() => endSub.unsubscribe(),
			() => errorSub.unsubscribe(),
		)

		this.registerInterval(
			window.setInterval(() => {
				const [locale] = navigator.language.split('-')
				i18n.changeLanguage(locale)
			}, 60000),
		)
		this.addRibbonIcon('refresh-ccw', i18n.t('sync.startButton'), async () => {
			const sync = new NutStoreSync({
				webdav: this.createWebDAVClient(),
				vault: this.app.vault,
				token: toBase64(`${this.settings.account}:${this.settings.credential}`),
				remoteBaseDir: stdRemotePath(
					this.settings.remoteDir || this.app.vault.getName(),
				),
			})
			await sync.start()
		})
		this.registerObsidianProtocolHandler('nutstore-sync/sso', () => {
			// TODO: save access_token
		})
	}

	async onunload() {
		this.subscriptions.forEach((unsub) => unsub())
	}

	updateLanguage() {
		const [locale] = navigator.language.split('-')
		i18n.changeLanguage(locale)
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
	}

	async saveSettings() {
		await this.saveData(this.settings)
	}

	createWebDAVClient() {
		return createClient(DAV_API, {
			username: this.settings.account,
			password: this.settings.credential,
		})
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
