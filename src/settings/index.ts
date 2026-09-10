import {
	App,
	Platform,
	PluginSettingTab,
	requireApiVersion,
	type SettingDefinitionItem,
	type SettingDefinitionRender,
} from 'obsidian'
import { Subscription } from 'rxjs'
import { AIProviderConfigs, AIProviderDefinitions } from '~/ai/core/types'
import { onNutstoreLlmGatewayAuth } from '~/events/nutstore-llm-gateway-auth'
import { onSsoReceive } from '~/events/sso-receive'
import i18n from '~/i18n'
import type NutstorePlugin from '~/index'
import type { NutstoreLlmGatewayAuthSettings } from '~/services/nutstore-llm-gateway.service'
import { ConflictStrategy } from '~/sync/tasks/conflict-resolve.task'
import { DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE } from '~/utils/download-chunk-size'
import { GlobFilterRule } from '~/utils/glob-match'
import { toggleClassTokens } from '~/utils/class-tokens'
import AccountSettings from './sync/account'
import AISettings from './ai/settings'
import SubagentSettingsSection from './ai/subagents'
import AutomationSettings from './sync/automation'
import FilterSettings from './sync/filter'
import InterfaceSettings from './sync/interface'
import SynchronizationSettings from './sync/synchronization'
import TransferSettings from './sync/transfer'
import PluginRuntimeInfoSettings from './troubleshooting/plugin-runtime-info'
import BaseSettings from './settings.base'
import SyncBackupReminderSettings from './sync/backup-reminder'
import { SETTINGS_TABS, SettingsTabKey } from './tabs'
import TroubleshootingSettings from './troubleshooting/settings'

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

export type ConflictStrategyI18nKey =
	'noConflictMerge' | 'diff3' | 'localPriority' | 'serverPriority'

export function getConflictStrategyI18nKey(
	strategy: ConflictStrategy,
): ConflictStrategyI18nKey {
	switch (strategy) {
		case ConflictStrategy.NoConflictMerge:
			return 'noConflictMerge'
		case ConflictStrategy.LocalPriority:
			return 'localPriority'
		case ConflictStrategy.ServerPriority:
			return 'serverPriority'
		case ConflictStrategy.Diff3:
		default:
			return 'diff3'
	}
}

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
		rules: GlobFilterRule[]
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
		subagents: {
			explorer: SubagentSettings
			memory: SubagentSettings
		}
		nutstoreLlmGateway?: NutstoreLlmGatewayAuthSettings
	}
	configDirSyncMode?: 'none' | 'bookmarks' | 'all'
}

export interface SubagentSettings {
	enabled: boolean
	/** Optional explicit model; an enabled subagent otherwise inherits its caller. */
	model?: { providerId: string; modelId: string }
}

function exclude(expr: string): GlobFilterRule {
	return {
		expr,
		options: {
			caseSensitive: false,
		},
		type: 'exclude',
	}
}

export const DEFAULT_SETTINGS: NutstoreSettings = {
	account: '',
	credential: '',
	nutstoreEnterpriseBaseUrl: '',
	remoteDir: '',
	conflictStrategy: ConflictStrategy.NoConflictMerge,
	oauthResponseText: '',
	loginMode: 'sso',
	confirmBeforeSync: true,
	confirmBeforeDeleteInAutoSync: true,
	syncMode: SyncMode.LOOSE,
	filterRules: {
		rules: [
			'**/*.nutstore-sync-*.download',
			'**/__MACOSX',
			'**/.DS_Store',
			'**/.env',
			'**/.nomedia',
			'**/.env.*',
			'**/.git',
			'**/.github',
			'**/.gitlab',
			'**/.idea',
			'**/.svn',
			'**/.trash',
			'**/.vscode',
			'**/.codex',
			'**/.opencode',
			'**/.claude',
			'**/.cursor',
			'**/~$*.doc',
			'**/~$*.docx',
			'**/~$*.ppt',
			'**/~$*.pptx',
			'**/~$*.xls',
			'**/~$*.xlsx',
			'**/desktop.ini',
			'**/node_modules',
			'**/Thumbs.db',
		].map(exclude),
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
		subagents: {
			explorer: { enabled: false },
			memory: { enabled: false },
		},
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

export class NutstoreSettingTab extends PluginSettingTab {
	plugin: NutstorePlugin
	accountSettings: AccountSettings
	synchronizationSettings: SynchronizationSettings
	automationSettings: AutomationSettings
	transferSettings: TransferSettings
	interfaceSettings: InterfaceSettings
	filterSettings: FilterSettings
	troubleshootingSettings: TroubleshootingSettings
	pluginRuntimeInfoSettings: PluginRuntimeInfoSettings
	aiSettings: AISettings
	subagentSettings: SubagentSettingsSection
	syncBackupReminderSettings: SyncBackupReminderSettings
	private tabBarEl: HTMLElement
	private activeTab: SettingsTabKey = 'sync'
	private readonly tabSections: Record<SettingsTabKey, BaseSettings[]>

	private readonly definitionTargets = new Map<
		SettingDefinitionItem,
		{
			tab: SettingsTabKey
			element?: HTMLElement
			groupEl?: HTMLElement
		}
	>()

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
		const syncBackupReminderContainerEl = this.containerEl.createDiv()
		this.syncBackupReminderSettings = new SyncBackupReminderSettings(
			this.app,
			this.plugin,
			this,
			syncBackupReminderContainerEl,
		)
		const accountContainerEl = this.containerEl.createDiv()
		this.accountSettings = new AccountSettings(
			this.app,
			this.plugin,
			this,
			accountContainerEl,
		)
		const synchronizationContainerEl = this.containerEl.createDiv()
		this.synchronizationSettings = new SynchronizationSettings(
			this.app,
			this.plugin,
			this,
			synchronizationContainerEl,
		)
		const automationContainerEl = this.containerEl.createDiv()
		this.automationSettings = new AutomationSettings(
			this.app,
			this.plugin,
			this,
			automationContainerEl,
		)
		const transferContainerEl = this.containerEl.createDiv()
		this.transferSettings = new TransferSettings(
			this.app,
			this.plugin,
			this,
			transferContainerEl,
		)
		const interfaceContainerEl = this.containerEl.createDiv()
		this.interfaceSettings = new InterfaceSettings(
			this.app,
			this.plugin,
			this,
			interfaceContainerEl,
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
		const subagentsContainerEl = this.containerEl.createDiv()
		this.subagentSettings = new SubagentSettingsSection(
			this.app,
			this.plugin,
			this,
			subagentsContainerEl,
		)
		const troubleshootingContainerEl = this.containerEl.createDiv()
		const pluginRuntimeInfoContainerEl = this.containerEl.createDiv()
		this.pluginRuntimeInfoSettings = new PluginRuntimeInfoSettings(
			this.app,
			this.plugin,
			this,
			pluginRuntimeInfoContainerEl,
		)
		this.troubleshootingSettings = new TroubleshootingSettings(
			this.app,
			this.plugin,
			this,
			troubleshootingContainerEl,
		)
		this.tabSections = {
			sync: [
				this.syncBackupReminderSettings,
				this.accountSettings,
				this.synchronizationSettings,
				this.automationSettings,
				this.transferSettings,
				this.interfaceSettings,
				this.filterSettings,
			],
			ai: [this.aiSettings, this.subagentSettings],
			troubleshooting: [
				this.pluginRuntimeInfoSettings,
				this.troubleshootingSettings,
			],
		}
	}

	// Keep every section searchable, including inactive tabs. Visual visibility
	// belongs to our panels; definition.visible would also remove search entries.
	getSettingDefinitions(): SettingDefinitionItem[] {
		this.definitionTargets.clear()
		this.renderTabBar()
		const definitions: SettingDefinitionItem[] = []
		for (const tab of SETTINGS_TABS) {
			for (const section of this.tabSections[tab.key]) {
				const { name, containerEl, searchable, showGroupHeading } = section
				const target: {
					tab: SettingsTabKey
					element?: HTMLElement
					groupEl?: HTMLElement
				} = {
					tab: tab.key,
				}
				const definition: SettingDefinitionRender = {
					name: name(),
					searchable,
					aliases: searchable
						? [i18n.t(tab.i18nKey), ...section.getSearchTerms()]
						: [],
					render: (setting, group) => {
						if (requireApiVersion('1.13.0')) {
							const groupEl = group.listEl.closest<HTMLElement>(
								'.ns-settings-section',
							)
							if (groupEl) {
								target.groupEl = groupEl
								this.mountTabBar(group.listEl)
								this.setSectionVisibility(groupEl, tab.key === this.activeTab)
							}
						}
						setting.settingEl.empty()
						setting.settingEl.removeClass('setting-item')
						setting.settingEl.appendChild(containerEl)
						target.element = setting.settingEl
						containerEl.show()
						void section.display()
						return () => {
							target.element = undefined
							if (section === this.accountSettings)
								void this.accountSettings.hide()
							if (section === this.troubleshootingSettings)
								this.troubleshootingSettings.hide()
						}
					},
				}
				this.definitionTargets.set(definition, target)
				definitions.push({
					type: 'group',
					heading: showGroupHeading ? name() : undefined,
					cls: 'ns-settings-section',
					items: [definition],
				})
			}
		}
		return definitions
	}

	private mountTabBar(anchorEl: HTMLElement) {
		if (requireApiVersion('1.13.0')) {
			if (!this.tabBarEl.isConnected) {
				anchorEl.before(this.tabBarEl)
				this.renderTabBar()
			}
		}
	}

	// Obsidian 1.13 calls this host hook before scrolling to a search result,
	// including on touch devices where no focus event follows. It is not yet
	// declared in the public typings; keep the integration confined here.
	getElementForDefinition(
		definition: SettingDefinitionItem,
	): HTMLElement | undefined {
		const target = this.definitionTargets.get(definition)
		if (!target?.element) return undefined
		this.activeTab = target.tab
		this.renderTabBar()
		this.updatePanelVisibility()
		for (const section of this.tabSections[target.tab])
			section.containerEl.show()
		return target.element
	}

	private updatePanelVisibility() {
		for (const { tab, groupEl } of this.definitionTargets.values()) {
			if (groupEl) this.setSectionVisibility(groupEl, tab === this.activeTab)
		}
	}

	private setSectionVisibility(groupEl: HTMLElement, visible: boolean) {
		const containsNavigation = groupEl.contains(this.tabBarEl)
		toggleClassTokens(groupEl, ':uno: hidden', !visible && !containsNavigation)
		if (!containsNavigation) return
		for (const child of Array.from(groupEl.children)) {
			if (child !== this.tabBarEl)
				toggleClassTokens(child, ':uno: hidden', !visible)
		}
	}

	display() {
		this.renderTabBar()
		void this.renderActiveTabContent()
	}

	private async renderActiveTabContent() {
		this.updatePanelVisibility()
		for (const tab of SETTINGS_TABS) {
			const isActive = tab.key === this.activeTab
			for (const section of this.tabSections[tab.key]) {
				if (isActive) section.containerEl.show()
				else section.containerEl.hide()
			}
		}
		for (const section of this.tabSections[this.activeTab]) {
			await section.display()
		}
	}

	private renderTabBar() {
		this.tabBarEl.empty()
		const barEl = this.tabBarEl.createDiv({ cls: 'ns-settings-tabs' })
		barEl.setAttribute('role', 'tablist')
		// Settings may live in a host shadow root, outside body platform classes.
		barEl.toggleClass('is-mobile', Platform.isMobile)
		const buttonEls = new Map<SettingsTabKey, HTMLElement>()
		for (const tab of SETTINGS_TABS) {
			const buttonEl = barEl.createEl('button', {
				cls: 'ns-settings-tab',
				text: i18n.t(tab.i18nKey),
			})
			buttonEl.setAttribute('type', 'button')
			buttonEl.setAttribute('role', 'tab')
			buttonEl.tabIndex = tab.key === this.activeTab ? 0 : -1
			buttonEl.setAttribute('aria-selected', String(tab.key === this.activeTab))
			buttonEl.classList.toggle('is-active', tab.key === this.activeTab)
			buttonEl.addEventListener('click', () => {
				if (this.activeTab !== tab.key) {
					this.activeTab = tab.key
					for (const [key, el] of buttonEls) {
						el.classList.toggle('is-active', key === this.activeTab)
						el.setAttribute('aria-selected', String(key === this.activeTab))
						el.tabIndex = key === this.activeTab ? 0 : -1
					}
					void this.renderActiveTabContent()
				}
			})
			buttonEl.addEventListener('keydown', (event) => {
				const index = SETTINGS_TABS.findIndex((entry) => entry.key === tab.key)
				const next =
					event.key === 'Home'
						? 0
						: event.key === 'End'
							? SETTINGS_TABS.length - 1
							: event.key === 'ArrowRight'
								? (index + 1) % SETTINGS_TABS.length
								: event.key === 'ArrowLeft'
									? (index + SETTINGS_TABS.length - 1) % SETTINGS_TABS.length
									: undefined
				if (next === undefined) return
				event.preventDefault()
				const button = buttonEls.get(SETTINGS_TABS[next].key)
				button?.click()
				button?.focus()
			})
			buttonEls.set(tab.key, buttonEl)
		}
	}

	get isSSO() {
		return this.plugin.settings.loginMode === 'sso'
	}

	isVisible() {
		return Object.values(this.tabSections)
			.flat()
			.some(
				(section) =>
					section.containerEl.isConnected &&
					section.containerEl.offsetParent !== null,
			)
	}

	async rerenderIfVisible() {
		// Obsidian 1.13+ caches translated definitions for both pages and search.
		if (requireApiVersion('1.13.0')) {
			this.update()
			return
		}
		if (this.isVisible()) {
			this.renderTabBar()
			await this.renderActiveTabContent()
		}
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
