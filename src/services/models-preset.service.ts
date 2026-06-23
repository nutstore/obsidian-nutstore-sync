import {
	getPresetProviders,
	resetPresetProvidersSource,
	sanitizePresetProviders,
	setPresetProvidersSource,
} from '~/ai/catalog/config'
import { obsidianFetch } from '~/ai/transport/obsidian-fetch'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'

const MODELS_API_URL = 'https://models.dev/api.json'

export interface ModelsPresetRefreshResult {
	success: boolean
	providersDelta: number
	modelsDelta: number
	errorMessage?: string
}

function countProvidersAndModels(
	providers: Record<string, { models: Record<string, unknown> }>,
) {
	const providersCount = Object.keys(providers).length
	const modelsCount = Object.values(providers).reduce(
		(count, provider) => count + Object.keys(provider.models || {}).length,
		0,
	)
	return { modelsCount, providersCount }
}

export default class ModelsPresetService {
	constructor(private plugin: NutstorePlugin) {}

	initializeFromLocalSettings() {
		const providers = sanitizePresetProviders(
			this.plugin.localSettings.ai.presetModels,
		)
		if (!providers) {
			resetPresetProvidersSource()
			return
		}
		setPresetProvidersSource(providers)
	}

	async refreshFromRemote(): Promise<ModelsPresetRefreshResult> {
		try {
			const currentCounts = countProvidersAndModels(getPresetProviders())
			const response = await obsidianFetch(MODELS_API_URL, {
				method: 'GET',
			})
			if (!response.ok) {
				return {
					success: false,
					modelsDelta: 0,
					providersDelta: 0,
					errorMessage: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
				}
			}
			const payload = await response.json()
			const providers = sanitizePresetProviders(payload)
			if (!providers) {
				return {
					success: false,
					modelsDelta: 0,
					providersDelta: 0,
					errorMessage: 'Invalid models payload',
				}
			}
			const nextCounts = countProvidersAndModels(providers)
			setPresetProvidersSource(providers)
			this.plugin.localSettings.ai.presetModels = providers
			this.plugin.localSettings.ai.presetModelsUpdatedAt =
				new Date().toISOString()
			await this.plugin.settingsService.saveLocalSettings()
			return {
				success: true,
				providersDelta:
					nextCounts.providersCount - currentCounts.providersCount,
				modelsDelta: nextCounts.modelsCount - currentCounts.modelsCount,
			}
		} catch (error) {
			logger.error(error)
			return {
				success: false,
				modelsDelta: 0,
				providersDelta: 0,
				errorMessage: error instanceof Error ? error.message : String(error),
			}
		}
	}
}
