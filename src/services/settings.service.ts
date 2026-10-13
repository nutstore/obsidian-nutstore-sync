import { normalizeModuleState } from '~/modules/lifecycle'
import { debounce } from 'es-toolkit/compat'
import { normalizePath, Notice } from 'obsidian'
import {
	sanitizeDefaultSelections,
	sanitizeProviders,
} from '~/ai/catalog/config'
import {
	normalizeMemoryNotePath,
	type MemorySettings,
} from '~/ai/memory/memory-note'
import {
	applyNormalizedSettingsPatch,
	type NormalizedSettingsPatch,
} from '~/ai/tools/settings-whitelist'
import i18n from '~/i18n'
import {
	DEFAULT_LOCAL_SETTINGS,
	DEFAULT_SETTINGS,
	type NutstoreLocalSettings,
	type NutstoreSettings,
} from '~/settings'
import { ConflictStrategy } from '~/sync/tasks/conflict-resolve.task'
import { DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE } from '~/utils/download-chunk-size'
import { migrateLegacyFilterRules } from '~/utils/glob-match'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'
import { BaseService } from './service.interface'

export default class SettingsService extends BaseService {
	private reloadSettingsPromise: Promise<void> | null = null
	private readonly debouncedReloadSettingsFromDisk = debounce(() => {
		void this.reloadSettingsFromDisk()
	}, 500)

	constructor(private plugin: NutstorePlugin) {
		super()
	}

	override async onload() {
		await this.loadSettings()
		await this.loadLocalSettings()
	}

	override onunload() {
		this.debouncedReloadSettingsFromDisk.cancel()
	}

	async loadSettings() {
		const loadedSettings = (await this.plugin.loadData()) as unknown
		const storedSettings =
			loadedSettings && typeof loadedSettings === 'object'
				? (loadedSettings as Partial<NutstoreSettings>)
				: {}
		this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS, storedSettings)
		this.plugin.settings.syncModule = normalizeModuleState(
			storedSettings.syncModule,
		)
		this.plugin.settings.aiModule = normalizeModuleState(
			storedSettings.aiModule,
		)
		if (
			storedSettings?.conflictStrategy !== undefined &&
			!Object.values(ConflictStrategy).includes(storedSettings.conflictStrategy)
		) {
			this.plugin.settings.conflictStrategy = DEFAULT_SETTINGS.conflictStrategy
		}
		// Stored data may predate the unified `{ rules }` shape and still use
		// the legacy `{ exclusionRules, inclusionRules }` split; the parameter
		// type accepts both.
		const migratedFilterRules = migrateLegacyFilterRules(
			this.plugin.settings.filterRules,
		)
		// Always normalize so the runtime never sees an undefined rules list;
		// persist only when a legacy split shape actually required migration.
		this.plugin.settings.filterRules = { rules: migratedFilterRules.rules }
		if (migratedFilterRules.migrated) {
			// saveData is used instead of saveSettings to avoid touching
			// services that may not be initialized during onload.
			await this.plugin.saveData(this.plugin.settings)
		}
		this.plugin.settings.mobileAppDownloadFileChunkSize ||=
			(this.plugin.settings as { downloadChunkSize?: string })
				.downloadChunkSize || DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE
		this.plugin.settings.ai ??= {
			providers: {},
			defaultModel: undefined,
			yolo: false,
			disabledSkills: [],
			subagents: {
				explorer: { enabled: false },
			},
			memory: { ...DEFAULT_SETTINGS.ai.memory },
		}
		this.plugin.settings.ai.subagents ??= {
			explorer: { enabled: false },
		}
		this.plugin.settings.ai.subagents.explorer ??= { enabled: false }
		this.plugin.settings.ai.subagents.explorer.enabled ??= false
		const memory: Partial<MemorySettings> = this.plugin.settings.ai.memory ?? {}
		this.plugin.settings.ai.memory = {
			enabled: memory.enabled ?? DEFAULT_SETTINGS.ai.memory.enabled,
			path:
				normalizeMemoryNotePath(memory.path ?? '') ??
				DEFAULT_SETTINGS.ai.memory.path,
		}
		this.plugin.settings.ai.disabledSkills = [
			...new Set(
				(Array.isArray(this.plugin.settings.ai.disabledSkills)
					? this.plugin.settings.ai.disabledSkills
					: []
				).filter(
					(name): name is string => typeof name === 'string' && name.length > 0,
				),
			),
		]
		this.plugin.settings.ai.nutstoreLlmGateway ??= {}
		if (Array.isArray(this.plugin.settings.ai.providers)) {
			this.plugin.settings.ai.providers = {}
		}
		let providersValid = true
		try {
			this.plugin.settings.ai.providers = sanitizeProviders(
				this.plugin.settings.ai.providers ?? {},
			)
		} catch (error) {
			logger.error(error)
			const detail =
				error instanceof Error ? error.message : 'Unknown validation error'
			new Notice(
				i18n.t('settings.ai.errors.invalidProvidersConfig', {
					reason: detail,
				}),
				10000,
			)
			providersValid = false
		}
		this.plugin.settings.ai.defaultModel = providersValid
			? sanitizeDefaultSelections(
					this.plugin.settings.ai.providers,
					this.plugin.settings.ai.defaultModel,
				)
			: undefined
	}

	async saveSettings() {
		// Begin revocation before the first persistence await.
		const applied = this.plugin.applySettings()
		await Promise.all([this.plugin.saveData(this.plugin.settings), applied])
	}

	async applySettingsPatch(patch: NormalizedSettingsPatch) {
		applyNormalizedSettingsPatch(this.plugin.settings, patch)
		await this.saveSettings()
		await this.plugin.settingTab?.rerenderIfVisible()
	}

	async loadLocalSettings() {
		const path = normalizePath(`${this.plugin.manifest.dir}/data.local.json`)
		if (!(await this.plugin.app.vault.adapter.exists(path))) {
			this.plugin.localSettings = { ...DEFAULT_LOCAL_SETTINGS }
			return
		}
		try {
			const raw = await this.plugin.app.vault.adapter.read(path)
			this.plugin.localSettings = Object.assign(
				{},
				DEFAULT_LOCAL_SETTINGS,
				JSON.parse(raw),
			) as NutstoreLocalSettings
			this.plugin.localSettings.ai ??= {}
		} catch {
			this.plugin.localSettings = { ...DEFAULT_LOCAL_SETTINGS }
		}
	}

	async saveLocalSettings() {
		const path = normalizePath(`${this.plugin.manifest.dir}/data.local.json`)
		await this.plugin.app.vault.adapter.write(
			path,
			JSON.stringify(this.plugin.localSettings, null, 2),
		)
	}

	scheduleReloadSettingsFromDisk() {
		this.debouncedReloadSettingsFromDisk()
	}

	async reloadSettingsFromDisk() {
		if (this.reloadSettingsPromise) {
			return this.reloadSettingsPromise
		}

		const reloadPromise = (async () => {
			await this.loadSettings()
			await this.loadLocalSettings()
			const previousGateway = this.plugin.ai.gateway
			await this.plugin.applySettings()
			if (
				this.plugin.ai.lifecycle.active &&
				this.plugin.ai.gateway === previousGateway
			) {
				await this.plugin.ai.lifecycle.scope.background(
					() => previousGateway.initializeProviderFromStoredAuth(),
					(error) => logger.error(error),
				)
			}
			await this.plugin.settingTab?.rerenderIfVisible()
		})()

		this.reloadSettingsPromise = reloadPromise
		try {
			await reloadPromise
		} finally {
			if (this.reloadSettingsPromise === reloadPromise) {
				this.reloadSettingsPromise = null
			}
		}
	}
}
