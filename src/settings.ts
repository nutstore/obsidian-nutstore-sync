import { App, Notice, PluginSettingTab, Setting } from 'obsidian'
import i18n from './i18n'
import NutStorePlugin from './index'

export class NutstoreSettingTab extends PluginSettingTab {
	plugin: NutStorePlugin

	constructor(app: App, plugin: NutStorePlugin) {
		super(app, plugin)
		this.plugin = plugin
	}

	display(): void {
		const { containerEl } = this

		containerEl.empty()

		containerEl.createEl('h2', { text: i18n.t('settings.title') })

		new Setting(containerEl)
			.setName(i18n.t('settings.account.name'))
			.setDesc(i18n.t('settings.account.desc'))
			.addText((text) =>
				text
					.setPlaceholder(i18n.t('settings.account.placeholder'))
					.setValue(this.plugin.settings.account)
					.onChange(async (value) => {
						this.plugin.settings.account = value
						await this.plugin.saveSettings()
					}),
			)

		new Setting(containerEl)
			.setName(i18n.t('settings.password.name'))
			.setDesc(i18n.t('settings.password.desc'))
			.addText((text) => {
				text

					.setPlaceholder(i18n.t('settings.password.placeholder'))
					.setValue(this.plugin.settings.password)
					.onChange(async (value) => {
						this.plugin.settings.password = value
						await this.plugin.saveSettings()
					})
				text.inputEl.type = 'password'
			})

		new Setting(containerEl)
			.setName(i18n.t('settings.remoteDir.name'))
			.setDesc(i18n.t('settings.remoteDir.desc'))
			.addText((text) =>
				text
					.setPlaceholder(i18n.t('settings.remoteDir.placeholder'))
					.setValue(this.plugin.settings.remoteDir)
					.onChange(async (value) => {
						this.plugin.settings.remoteDir = value
						await this.plugin.saveSettings()
					}),
			)

		new Setting(containerEl)
			.setName(i18n.t('settings.checkConnection.name'))
			.setDesc(i18n.t('settings.checkConnection.desc'))
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.checkConnection.name'))
					.onClick(async () => {
						const isConnected = await this.plugin.checkWebDAVConnection()
						if (isConnected) {
							new Notice(i18n.t('settings.checkConnection.success'))
						} else {
							new Notice(i18n.t('settings.checkConnection.failure'))
						}
					})
			})
	}
}
