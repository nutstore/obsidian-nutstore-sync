import { App, PluginSettingTab, Setting } from 'obsidian'
import { onSsoReceive } from '~/events/sso-receive'
import i18n from '~/i18n'
import type NutstorePlugin from '~/index'
import { ConflictStrategy } from '~/sync/tasks/conflict-resolve.task'
import { GlobMatchOptions } from '~/utils/glob-match'
import waitUntil from '~/utils/wait-until'
import AccountSettings from './account'
import CacheSettings from './cache'
import CommonSettings from './common'
import FilterSettings from './filter'
import LogSettings from './log'

export enum SyncMode {
	STRICT = 'strict',
	LOOSE = 'loose',
}

export interface NutstoreSettings {
	account: string
	credential: string
	remoteDir: string
	remoteCacheDir?: string
	useGitStyle: boolean
	conflictStrategy: ConflictStrategy
	oauthResponseText: string
	loginMode: 'manual' | 'sso'
	confirmBeforeSync: boolean
	confirmBeforeDeleteInAutoSync: boolean
	syncMode: SyncMode
	filterRules: {
		exclusionRules: GlobMatchOptions[]
		inclusionRules: GlobMatchOptions[]
	}
	skipLargeFiles: {
		maxSize: string
	}
	realtimeSync: boolean
	startupSyncDelaySeconds: number
	autoSyncIntervalSeconds: number
	language?: 'zh' | 'en'
}

let pluginInstance: NutstorePlugin | null = null

export function setPluginInstance(plugin: NutstorePlugin | null) {
	pluginInstance = plugin
}

export function waitUntilPluginInstance() {
	return waitUntil(() => !!pluginInstance, 100)
}

export async function useSettings() {
	await waitUntilPluginInstance()
	return pluginInstance!.settings
}

export class NutstoreSettingTab extends PluginSettingTab {
	plugin: NutstorePlugin
	accountSettings: AccountSettings
	commonSettings: CommonSettings
	filterSettings: FilterSettings
	logSettings: LogSettings
	cacheSettings: CacheSettings
	warningContainerEl: HTMLElement

	subSso = onSsoReceive().subscribe(() => {
		this.display()
	})

	constructor(app: App, plugin: NutstorePlugin) {
		super(app, plugin)
		this.plugin = plugin
		this.warningContainerEl = this.containerEl.createDiv()
		this.accountSettings = new AccountSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.commonSettings = new CommonSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.filterSettings = new FilterSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.cacheSettings = new CacheSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.logSettings = new LogSettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
	}

	async display() {
		this.warningContainerEl.empty()
		new Setting(this.warningContainerEl)
			.setName(i18n.t('settings.backupWarning.name'))
			.setDesc(i18n.t('settings.backupWarning.desc'))
		await this.accountSettings.display()
		await this.commonSettings.display()
		await this.filterSettings.display()
		await this.cacheSettings.display()
		await this.logSettings.display()
	}

	get isSSO() {
		return this.plugin.settings.loginMode === 'sso'
	}

	async hide() {
		await this.accountSettings.hide()
	}
}
