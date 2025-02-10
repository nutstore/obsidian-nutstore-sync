import { App, PluginSettingTab, Setting } from 'obsidian'
import i18n from './i18n'
import MyPlugin from './index'

export class NutstoreSettingTab extends PluginSettingTab {
	plugin: MyPlugin

	constructor(app: App, plugin: MyPlugin) {
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
			.addText((text) =>
				text
					.setPlaceholder(i18n.t('settings.password.placeholder'))
					.setValue(this.plugin.settings.password)
					.onChange(async (value) => {
						this.plugin.settings.password = value
						await this.plugin.saveSettings()
					}),
			)
	}
}
