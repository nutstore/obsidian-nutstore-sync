import { App, PluginSettingTab, Setting } from 'obsidian'
import { onSsoReceive } from '~/events/sso-receive'
import i18n from '~/i18n'
import type NutstorePlugin from '~/index'
import { GlobMatchOptions } from '~/utils/glob-match'
import AccountSettings from './account'
import CommonSettings from './common'
import LogSettings from './log'

export interface NutstoreSettings {
	account: string
	credential: string
	remoteDir: string
	useGitStyle: boolean
	conflictStrategy: 'diff-match-patch' | 'latest-timestamp'
	oauthResponseText: string
	loginMode: 'manual' | 'sso'
	confirmBeforeSync: boolean
	filters: GlobMatchOptions[]
}

export const DEFAULT_SETTINGS: NutstoreSettings = {
	account: '',
	credential: '',
	remoteDir: '',
	useGitStyle: false,
	conflictStrategy: 'diff-match-patch',
	oauthResponseText: '',
	loginMode: 'sso',
	confirmBeforeSync: true,
	filters: ['.git', '.DS_Store', '.Trash'],
}

let pluginInstance: NutstorePlugin | null = null

export function setPluginInstance(plugin: NutstorePlugin | null) {
	pluginInstance = plugin
}

export function useSettings() {
	if (!pluginInstance) {
		throw new Error('Plugin not initialized')
	}
	return pluginInstance.settings
}

export class NutstoreSettingTab extends PluginSettingTab {
	plugin: NutstorePlugin
	accountSettings: AccountSettings
	commonSettings: CommonSettings
	logSettings: LogSettings

	subSso = onSsoReceive().subscribe(() => {
		this.display()
	})

	constructor(app: App, plugin: NutstorePlugin) {
		super(app, plugin)
		this.plugin = plugin
		this.accountSettings = new AccountSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl,
		)
		this.commonSettings = new CommonSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl,
		)
		this.logSettings = new LogSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl,
		)
	}

	async display() {
		const { containerEl } = this
		containerEl.empty()
		new Setting(containerEl)
			.setName(i18n.t('settings.backupWarning.name'))
			.setDesc(i18n.t('settings.backupWarning.desc'))
		await this.accountSettings.display()
		await this.commonSettings.display()
		await this.logSettings.display()
	}

	get isSSO() {
		return this.plugin.settings.loginMode === 'sso'
	}

	async hide() {
		await this.accountSettings.hide()
	}
}
