import { App, Notice, PluginSettingTab, Setting } from 'obsidian'
import i18n from './i18n'
import type NutStorePlugin from './index'

export interface NutstoreSettings {
	account: string
	credential: string
	remoteDir: string
	useGitStyle: boolean
	conflictStrategy: 'diff-match-patch' | 'latest-timestamp'
}

export const DEFAULT_SETTINGS: NutstoreSettings = {
	account: '',
	credential: '',
	remoteDir: '',
	useGitStyle: false,
	conflictStrategy: 'diff-match-patch',
}

let pluginInstance: NutStorePlugin | null = null

export function setPluginInstance(plugin: NutStorePlugin | null) {
	pluginInstance = plugin
}

export function useSettings() {
	if (!pluginInstance) {
		throw new Error('Plugin not initialized')
	}
	return pluginInstance.settings
}

export class NutstoreSettingTab extends PluginSettingTab {
	plugin: any // 改为 any 类型避免循环依赖

	constructor(app: App, plugin: any) {
		super(app, plugin)
		this.plugin = plugin
	}

	display(): void {
		const { containerEl } = this

		containerEl.empty()

		containerEl.createEl('h2', { text: i18n.t('settings.title') })

		new Setting(containerEl)
			.setName(i18n.t('settings.backupWarning.name'))
			.setDesc(i18n.t('settings.backupWarning.desc'))

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
			.setName(i18n.t('settings.credential.name'))
			.setDesc(i18n.t('settings.credential.desc'))
			.addText((text) => {
				text

					.setPlaceholder(i18n.t('settings.credential.placeholder'))
					.setValue(this.plugin.settings.credential)
					.onChange(async (value) => {
						this.plugin.settings.credential = value
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
			.setName(i18n.t('settings.useGitStyle.name'))
			.setDesc(i18n.t('settings.useGitStyle.desc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.useGitStyle)
					.onChange(async (value) => {
						this.plugin.settings.useGitStyle = value
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

		new Setting(containerEl)
			.setName(i18n.t('settings.conflictStrategy.name'))
			.setDesc(i18n.t('settings.conflictStrategy.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption(
						'diff-match-patch',
						i18n.t('settings.conflictStrategy.diffMatchPatch'),
					)
					.addOption(
						'latest-timestamp',
						i18n.t('settings.conflictStrategy.latestTimestamp'),
					)
					.setValue(this.plugin.settings.conflictStrategy)
					.onChange(async (value: 'diff-match-patch' | 'latest-timestamp') => {
						this.plugin.settings.conflictStrategy = value
						await this.plugin.saveSettings()
					}),
			)
	}
}
