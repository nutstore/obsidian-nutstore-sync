import { Plugin } from 'obsidian'
import { createClient } from 'webdav'
import { DAV_API } from './consts'
import i18n from './i18n'
import { NutstoreSettingTab } from './settings'
import './webdav-patch'

interface MyPluginSettings {
	account: string
	password: string
	remoteDir: string
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	account: '',
	password: '',
	remoteDir: '',
}

export default class NutStorePlugin extends Plugin {
	settings: MyPluginSettings

	async onload() {
		await this.loadSettings()
		this.updateLanguage()
		this.addSettingTab(new NutstoreSettingTab(this.app, this))
		this.registerInterval(
			window.setInterval(() => {
				const [locale] = navigator.language.split('-')
				i18n.changeLanguage(locale)
			}, 60000),
		)
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
			password: this.settings.password,
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
