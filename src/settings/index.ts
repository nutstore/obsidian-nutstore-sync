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
import waitUntil from '~/utils/wait-until'
import AccountSettings from './account'
import AISettings from './ai'
import CommonSettings from './common'
import FilterSettings from './filter'
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
	useGitStyle: false,
	conflictStrategy: ConflictStrategy.DiffMatchPatch,
	oauthResponseText: '',
	loginMode: 'sso',
	confirmBeforeSync: true,
	confirmBeforeDeleteInAutoSync: true,
	syncMode: SyncMode.LOOSE,
	filterRules: {
		exclusionRules: [
			'**/.git',
			'**/.github',
			'**/.gitlab',
			'**/.svn',
			'**/node_modules',
			'**/.DS_Store',
			'**/__MACOSX',
			'**/desktop.ini',
			'**/Thumbs.db',
			'**/.trash',
			'**/~$*.doc',
			'**/~$*.docx',
			'**/~$*.ppt',
			'**/~$*.pptx',
			'**/~$*.xls',
			'**/~$*.xlsx',
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

export async function useLocalSettings() {
	await waitUntilPluginInstance()
	return pluginInstance!.localSettings
}

export class NutstoreSettingTab extends PluginSettingTab {
	plugin: NutstorePlugin
	accountSettings: AccountSettings
	commonSettings: CommonSettings
	filterSettings: FilterSettings
	troubleshootingSettings: TroubleshootingSettings
	aiSettings: AISettings
	warningContainerEl: HTMLElement

	private readonly subscriptions: Subscription[] = [
		onSsoReceive().subscribe(() => {
			this.display()
		}),
		onNutstoreLlmGatewayAuth().subscribe(() => {
			this.display()
		}),
	]

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
		this.aiSettings = new AISettings(
			this.app,
			this.plugin,
			this,
			this.containerEl.createDiv(),
		)
		this.troubleshootingSettings = new TroubleshootingSettings(
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
		await this.aiSettings.display()
		await this.troubleshootingSettings.display()
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

	async hide() {
		await this.accountSettings.hide()
		this.troubleshootingSettings.hide()
	}

	async onClose() {
		await this.hide()
		for (const subscription of this.subscriptions) {
			subscription.unsubscribe()
		}
	}
}
