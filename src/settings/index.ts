import { App, PluginSettingTab, Setting } from 'obsidian'
import { Subscription } from 'rxjs'
import { AIProviderConfigs, AIProviderDefinitions } from '~/ai/core/types'
import { onNutstoreLlmGatewayAuth } from '~/events/nutstore-llm-gateway-auth'
import { onSsoReceive } from '~/events/sso-receive'
import i18n from '~/i18n'
import type NutstorePlugin from '~/index'
import type { NutstoreLlmGatewayAuthSettings } from '~/services/nutstore-llm-gateway.service'
import { ConflictStrategy } from '~/sync/tasks/conflict-resolve.task'
import { DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE } from '~/utils/download-chunk-size'
import { GlobMatchOptions } from '~/utils/glob-match'
import AccountSettings from './account'
import AISettings from './ai'
import CommonSettings from './common'
import FilterSettings from './filter'
import BaseSettings from './settings.base'
import { SETTINGS_TABS, SettingsTabKey } from './tabs'
import TroubleshootingSettings from './troubleshooting'

export enum SyncMode {
	STRICT = 'strict',
	LOOSE = 'loose',
}

export enum SyncPolicy {
	TwoWay = 'two-way',
	SendOnly = 'send-only',
	SendOnlyOverrideChanges = 'send-only-override-changes',
	ReceiveOnly = 'receive-only',
	ReceiveOnlyRevertLocalChanges = 'receive-only-revert-local-changes',
}

export type SyncPolicyI18nKey =
	| 'twoWay'
	| 'sendOnly'
	| 'sendOnlyOverrideChanges'
	| 'receiveOnly'
	| 'receiveOnlyRevertLocalChanges'

export type SyncPolicyNameI18nKey =
	| 'settings.syncPolicy.twoWay'
	| 'settings.syncPolicy.sendOnly'
	| 'settings.syncPolicy.sendOnlyOverrideChanges'
	| 'settings.syncPolicy.receiveOnly'
	| 'settings.syncPolicy.receiveOnlyRevertLocalChanges'

export type SyncPolicyDescI18nKey =
	| 'settings.syncPolicy.modal.twoWayDesc'
	| 'settings.syncPolicy.modal.sendOnlyDesc'
	| 'settings.syncPolicy.modal.sendOnlyOverrideChangesDesc'
	| 'settings.syncPolicy.modal.receiveOnlyDesc'
	| 'settings.syncPolicy.modal.receiveOnlyRevertLocalChangesDesc'

export function getSyncPolicyI18nKey(policy: SyncPolicy): SyncPolicyI18nKey {
	switch (policy) {
		case SyncPolicy.SendOnly:
			return 'sendOnly'
		case SyncPolicy.SendOnlyOverrideChanges:
			return 'sendOnlyOverrideChanges'
		case SyncPolicy.ReceiveOnly:
			return 'receiveOnly'
		case SyncPolicy.ReceiveOnlyRevertLocalChanges:
			return 'receiveOnlyRevertLocalChanges'
		case SyncPolicy.TwoWay:
		default:
			return 'twoWay'
	}
}

export function getSyncPolicyNameI18nKey(
	policy: SyncPolicy,
): SyncPolicyNameI18nKey {
	switch (policy) {
		case SyncPolicy.SendOnly:
			return 'settings.syncPolicy.sendOnly'
		case SyncPolicy.SendOnlyOverrideChanges:
			return 'settings.syncPolicy.sendOnlyOverrideChanges'
		case SyncPolicy.ReceiveOnly:
			return 'settings.syncPolicy.receiveOnly'
		case SyncPolicy.ReceiveOnlyRevertLocalChanges:
			return 'settings.syncPolicy.receiveOnlyRevertLocalChanges'
		case SyncPolicy.TwoWay:
		default:
			return 'settings.syncPolicy.twoWay'
	}
}

export function getSyncPolicyDescI18nKey(
	policy: SyncPolicy,
): SyncPolicyDescI18nKey {
	switch (policy) {
		case SyncPolicy.SendOnly:
			return 'settings.syncPolicy.modal.sendOnlyDesc'
		case SyncPolicy.SendOnlyOverrideChanges:
			return 'settings.syncPolicy.modal.sendOnlyOverrideChangesDesc'
		case SyncPolicy.ReceiveOnly:
			return 'settings.syncPolicy.modal.receiveOnlyDesc'
		case SyncPolicy.ReceiveOnlyRevertLocalChanges:
			return 'settings.syncPolicy.modal.receiveOnlyRevertLocalChangesDesc'
		case SyncPolicy.TwoWay:
		default:
			return 'settings.syncPolicy.modal.twoWayDesc'
	}
}

export interface NutstoreSettings {
	account: string
	credential: string
	nutstoreEnterpriseBaseUrl: string
	remoteDir: string
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
	mobileAppDownloadFileChunkSize: string
	realtimeSync: boolean
	startupSyncDelaySeconds: number
	autoSyncIntervalSeconds: number
	language?: 'zh' | 'en'
	ai: {
		providers: AIProviderConfigs
		defaultModel?: { providerId: string; modelId: string }
		yolo?: boolean
		nutstoreLlmGateway?: NutstoreLlmGatewayAuthSettings
	}
	configDirSyncMode?: 'none' | 'bookmarks' | 'all'
}

function createGlobMathOptions(expr: string) {
	return {
		expr,
		options: {
			caseSensitive: false,
		},
	} satisfies GlobMatchOptions
}

export const DEFAULT_SETTINGS: NutstoreSettings = {
	account: '',
	credential: '',
	nutstoreEnterpriseBaseUrl: '',
	remoteDir: '',
	conflictStrategy: ConflictStrategy.DiffMatchPatch,
	oauthResponseText: '',
	loginMode: 'sso',
	confirmBeforeSync: true,
	confirmBeforeDeleteInAutoSync: true,
	syncMode: SyncMode.LOOSE,
	filterRules: {
		exclusionRules: [
			'**/__MACOSX',
			'**/.*',
			'**/.DS_Store',
			'**/.git',
			'**/.github',
			'**/.gitlab',
			'**/.svn',
			'**/.trash',
			'**/~$*.doc',
			'**/~$*.docx',
			'**/~$*.ppt',
			'**/~$*.pptx',
			'**/~$*.xls',
			'**/~$*.xlsx',
			'**/desktop.ini',
			'**/node_modules',
			'**/Thumbs.db',
		].map(createGlobMathOptions),
		inclusionRules: [],
	},
	skipLargeFiles: {
		maxSize: '30 MB',
	},
	mobileAppDownloadFileChunkSize: DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE,
	realtimeSync: false,
	startupSyncDelaySeconds: 0,
	autoSyncIntervalSeconds: 300,
	language: undefined,
	ai: {
		providers: {},
		defaultModel: undefined,
		yolo: false,
		nutstoreLlmGateway: {},
	},
	configDirSyncMode: 'none',
}

export interface NutstoreLocalSettings {
	syncPolicy: SyncPolicy
	ai: {
		presetModels?: AIProviderDefinitions
		presetModelsUpdatedAt?: string
	}
}

export const DEFAULT_LOCAL_SETTINGS: NutstoreLocalSettings = {
	syncPolicy: SyncPolicy.TwoWay,
	ai: {},
}

interface SettingsSectionEntry {
	section: BaseSettings
	containerEl: HTMLElement
}

export class NutstoreSettingTab extends PluginSettingTab {
	plugin: NutstorePlugin
	accountSettings: AccountSettings
	commonSettings: CommonSettings
	filterSettings: FilterSettings
	troubleshootingSettings: TroubleshootingSettings
	aiSettings: AISettings
	warningContainerEl: HTMLElement
	private tabBarEl: HTMLElement
	private activeTab: SettingsTabKey = 'sync'
	private readonly tabSections: Record<SettingsTabKey, SettingsSectionEntry[]>

	private readonly subscriptions: Subscription[] = [
		onSsoReceive().subscribe(() => {
			void this.rerenderIfVisible()
		}),
		onNutstoreLlmGatewayAuth().subscribe(() => {
			void this.rerenderIfVisible()
		}),
	]

	constructor(app: App, plugin: NutstorePlugin) {
		super(app, plugin)
		this.plugin = plugin
		this.tabBarEl = this.containerEl.createDiv()
		this.warningContainerEl = this.containerEl.createDiv()
		const accountContainerEl = this.containerEl.createDiv()
		this.accountSettings = new AccountSettings(
			this.app,
			this.plugin,
			this,
			accountContainerEl,
		)
		const commonContainerEl = this.containerEl.createDiv()
		this.commonSettings = new CommonSettings(
			this.app,
			this.plugin,
			this,
			commonContainerEl,
		)
		const filterContainerEl = this.containerEl.createDiv()
		this.filterSettings = new FilterSettings(
			this.app,
			this.plugin,
			this,
			filterContainerEl,
		)
		const aiContainerEl = this.containerEl.createDiv()
		this.aiSettings = new AISettings(this.app, this.plugin, this, aiContainerEl)
		const troubleshootingContainerEl = this.containerEl.createDiv()
		this.troubleshootingSettings = new TroubleshootingSettings(
			this.app,
			this.plugin,
			this,
			troubleshootingContainerEl,
		)
		this.tabSections = {
			sync: [
				{ section: this.accountSettings, containerEl: accountContainerEl },
				{ section: this.commonSettings, containerEl: commonContainerEl },
				{ section: this.filterSettings, containerEl: filterContainerEl },
			],
			ai: [{ section: this.aiSettings, containerEl: aiContainerEl }],
			troubleshooting: [
				{
					section: this.troubleshootingSettings,
					containerEl: troubleshootingContainerEl,
				},
			],
		}
	}

	async display() {
		this.renderTabBar()
		await this.renderActiveTabContent()
	}

	private async renderActiveTabContent() {
		const isSyncTab = this.activeTab === 'sync'
		this.warningContainerEl.style.display = isSyncTab ? '' : 'none'
		if (isSyncTab) {
			this.warningContainerEl.empty()
			new Setting(this.warningContainerEl)
				.setName(i18n.t('settings.backupWarning.name'))
				.setDesc(i18n.t('settings.backupWarning.desc'))
		}
		for (const tab of SETTINGS_TABS) {
			const isActive = tab.key === this.activeTab
			for (const { containerEl } of this.tabSections[tab.key]) {
				containerEl.style.display = isActive ? '' : 'none'
			}
			if (isActive) {
				for (const { section } of this.tabSections[tab.key]) {
					await section.display()
				}
			}
		}
	}

	private renderTabBar() {
		this.tabBarEl.empty()
		const barEl = this.tabBarEl.createDiv({ cls: 'ns-settings-tabs' })
		const buttonEls = new Map<SettingsTabKey, HTMLElement>()
		for (const tab of SETTINGS_TABS) {
			const buttonEl = barEl.createEl('button', {
				cls: 'ns-settings-tab',
				text: i18n.t(tab.i18nKey),
			})
			buttonEl.classList.toggle('is-active', tab.key === this.activeTab)
			buttonEl.addEventListener('click', () => {
				if (this.activeTab !== tab.key) {
					this.activeTab = tab.key
					for (const [key, el] of buttonEls) {
						el.classList.toggle('is-active', key === this.activeTab)
					}
					void this.renderActiveTabContent()
				}
			})
			buttonEls.set(tab.key, buttonEl)
		}
	}

	get isSSO() {
		return this.plugin.settings.loginMode === 'sso'
	}

	isVisible() {
		return (
			this.containerEl.isConnected &&
			document.contains(this.containerEl) &&
			this.containerEl.offsetParent !== null
		)
	}

	async rerenderIfVisible() {
		if (!this.isVisible()) {
			return
		}
		await this.display()
	}

	async onClose() {
		await this.accountSettings.hide()
		this.troubleshootingSettings.hide()
	}

	unload() {
		for (const subscription of this.subscriptions) {
			subscription.unsubscribe()
		}
	}
}
