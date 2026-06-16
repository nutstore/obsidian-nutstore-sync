import { debounce } from 'lodash-es'
import { normalizePath, Notice } from 'obsidian'
import { sanitizeDefaultSelections, sanitizeProviders } from '~/ai/config'
import i18n from '~/i18n'
import {
	DEFAULT_LOCAL_SETTINGS,
	DEFAULT_SETTINGS,
	type NutstoreLocalSettings,
	type NutstoreSettings,
} from '~/settings'
import { DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE } from '~/utils/download-chunk-size'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'

export default class SettingsService {
	private reloadSettingsPromise: Promise<void> | null = null
	private readonly debouncedReloadSettingsFromDisk = debounce(() => {
		void this.reloadSettingsFromDisk()
	}, 500)

	constructor(private plugin: NutstorePlugin) {}

	async initialize() {
		await this.loadSettings()
		await this.loadLocalSettings()
		this.plugin.modelsPresetService.initializeFromLocalSettings()
		await this.plugin.nutstoreLlmGatewayService.initializeProviderFromStoredAuth()
	}

	unload() {
		this.debouncedReloadSettingsFromDisk.cancel()
	}

	async loadSettings() {
		this.plugin.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.plugin.loadData(),
		) as NutstoreSettings
		this.plugin.settings.mobileAppDownloadFileChunkSize ||=
			(this.plugin.settings as { downloadChunkSize?: string })
				.downloadChunkSize || DEFAULT_MOBILE_APP_DOWNLOAD_FILE_CHUNK_SIZE
		this.plugin.settings.ai ??= {
			providers: {},
			defaultModel: undefined,
			yolo: false,
		}
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
		await this.plugin.saveData(this.plugin.settings)
		await this.plugin.chatService.handleSettingsChanged()
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
		} catch (_e) {
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
			this.plugin.modelsPresetService.initializeFromLocalSettings()
			await this.plugin.nutstoreLlmGatewayService.initializeProviderFromStoredAuth()
			await this.plugin.i18nService.update()
			await this.plugin.chatService.handleSettingsChanged()
			await this.plugin.scheduledSyncService.updateInterval()
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
