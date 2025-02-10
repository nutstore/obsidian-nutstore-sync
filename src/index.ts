import { Plugin } from 'obsidian'
import i18n from './i18n'
import { NutstoreSettingTab } from './settings'

// Remember to rename these classes and interfaces!

interface MyPluginSettings {
	account: string
	password: string
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	account: '',
	password: '',
}

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings
	localeCheckInterval: number

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

	onunload() {
		clearInterval(this.localeCheckInterval)
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
	}

	async saveSettings() {
		await this.saveData(this.settings)
	}
}
