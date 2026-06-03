import { z } from 'zod'
import modelsApiJson from './models-api.json'
import {
	AIModelConfig,
	AIModelConfigs,
	AIProviderConfig,
	AIProviderConfigs,
	AIProviderDefinition,
	AIProviderDefinitions,
	AIProviderInput,
	AIModelInput,
	AIModelInputs,
	aiProviderDefinitionsSchema,
	aiProviderInputsSchema,
} from './types'

const DEFAULT_NPM_PACKAGE = '@ai-sdk/openai-compatible'

const DEFAULT_MODALITIES: AIModelConfig['modalities'] = {
	input: ['text'],
	output: ['text'],
}

const DEFAULT_LIMIT: AIModelConfig['limit'] = { context: 0, output: 0 }

function formatSchemaIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
			return `${path}: ${issue.message}`
		})
		.join('; ')
}

export function createModelConfig(
	model: AIModelInput = {},
	fallbackId = '',
): AIModelConfig {
	const id = model.id?.trim() || fallbackId.trim()
	const modalities = model.modalities || DEFAULT_MODALITIES
	return {
		id,
		name: model.name?.trim() || '',
		family: model.family?.trim() || undefined,
		attachment: model.attachment ?? false,
		reasoning: model.reasoning ?? false,
		tool_call: model.tool_call ?? true,
		structured_output: model.structured_output,
		temperature: model.temperature ?? true,
		knowledge: model.knowledge?.trim() || undefined,
		release_date: model.release_date?.trim() || '',
		last_updated: model.last_updated?.trim() || '',
		modalities: {
			input: [...modalities.input],
			output: [...modalities.output],
		},
		open_weights: model.open_weights ?? false,
		cost: model.cost,
		limit: { ...(model.limit || DEFAULT_LIMIT) },
		interleaved: model.interleaved,
		provider: model.provider ? { ...model.provider } : undefined,
		status: model.status,
		experimental: model.experimental,
	}
}

export function createProviderConfig(
	provider: AIProviderInput = {},
	fallbackId = '',
): AIProviderConfig {
	const id = provider.id?.trim() || fallbackId.trim()
	return {
		id,
		env: [...(provider.env || [])],
		npm: provider.npm?.trim() || DEFAULT_NPM_PACKAGE,
		api: provider.api?.trim() || undefined,
		name: provider.name?.trim() || '',
		doc: provider.doc?.trim() || '',
		apiKey: provider.apiKey || '',
		allowBrowserCors: provider.allowBrowserCors ?? false,
		models: sanitizeModels(provider.models),
	}
}

function sanitizeModels(models: AIModelInputs | undefined): AIModelConfigs {
	return Object.fromEntries(
		Object.entries(models || {}).map(([modelId, model]) => {
			const config = createModelConfig(model, modelId)
			return [config.id, config]
		}),
	)
}

export function sanitizeProviders(providers: unknown): AIProviderConfigs {
	const parsed = aiProviderInputsSchema.safeParse(providers ?? {})
	if (!parsed.success) {
		throw new Error(`Invalid AI providers: ${formatSchemaIssues(parsed.error)}`)
	}

	return Object.fromEntries(
		Object.entries(parsed.data).map(([providerId, provider]) => {
			const config = createProviderConfig(provider, providerId)
			return [config.id, config]
		}),
	)
}

export function sanitizeDefaultSelections(
	providers: AIProviderConfigs,
	defaultModel?: { providerId: string; modelId: string },
): { providerId: string; modelId: string } | undefined {
	if (!defaultModel) return undefined
	const provider = getProviderById(providers, defaultModel.providerId)
	const model = getModelById(provider, defaultModel.modelId)
	if (!provider || !model) return undefined
	return { providerId: provider.id, modelId: model.id }
}

export function resolveInitialSelection(
	providers: AIProviderConfigs,
	defaultModel?: { providerId: string; modelId: string },
) {
	const validated = sanitizeDefaultSelections(providers, defaultModel)
	return {
		providerId: validated?.providerId,
		modelId: validated?.modelId,
	}
}

export function slugifyProviderId(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/\s+/g, '-')
		.replace(/[^a-z0-9-_]/g, '')
}

export function getProviderById(
	providers: AIProviderConfigs,
	providerId?: string,
) {
	return providerId ? providers[providerId] : undefined
}

export function getModelById(
	provider: AIProviderConfig | undefined,
	modelId?: string,
) {
	return modelId ? provider?.models[modelId] : undefined
}

export function listProviders(
	providers: AIProviderConfigs,
): AIProviderConfig[] {
	return Object.values(providers)
}

export function listModels(
	provider: AIProviderConfig | undefined,
): AIModelConfig[] {
	return Object.values(provider?.models || {})
}

export function getFirstModel(provider: AIProviderConfig | undefined) {
	return listModels(provider)[0]
}

let _presetProviders: AIProviderDefinitions | null = null

function parsePresetProviders(
	source: unknown,
): { success: true; data: AIProviderDefinitions } | { success: false } {
	const parsed = aiProviderDefinitionsSchema.safeParse(source)
	if (!parsed.success) {
		return { success: false }
	}
	return { success: true, data: parsed.data }
}

export function sanitizePresetProviders(
	source: unknown,
): AIProviderDefinitions | undefined {
	const parsed = parsePresetProviders(source)
	return parsed.success ? parsed.data : undefined
}

export function setPresetProvidersSource(source: unknown): boolean {
	const parsed = parsePresetProviders(source)
	if (!parsed.success) {
		return false
	}
	_presetProviders = parsed.data
	return true
}

export function resetPresetProvidersSource() {
	_presetProviders = null
}

export function getPresetProviders(): AIProviderDefinitions {
	if (_presetProviders) {
		return _presetProviders
	}
	const parsed = aiProviderDefinitionsSchema.safeParse(modelsApiJson)
	if (!parsed.success) {
		throw new Error(
			`Invalid preset AI providers: ${formatSchemaIssues(parsed.error)}`,
		)
	}
	_presetProviders = parsed.data
	return _presetProviders
}

export function listPresetProviders(): AIProviderDefinition[] {
	return Object.values(getPresetProviders()).sort((a, b) =>
		a.name.localeCompare(b.name),
	)
}

function normalizeProviderApi(api?: string): string | undefined {
	const trimmed = api?.trim()
	if (!trimmed) return undefined
	return trimmed.replace(/\/+$/, '')
}

export function findPresetProviderByApi(
	api?: string,
): AIProviderDefinition | undefined {
	const normalizedApi = normalizeProviderApi(api)
	if (!normalizedApi) return undefined

	for (const provider of Object.values(getPresetProviders())) {
		if (normalizeProviderApi(provider.api) === normalizedApi) {
			return provider
		}
	}

	return undefined
}

export function findPresetModelById(
	modelId: string,
	providerApi?: string,
): AIModelConfig | undefined {
	const targetId = modelId.trim()
	if (!targetId) return undefined

	const matchedProvider = findPresetProviderByApi(providerApi)
	if (matchedProvider) {
		const matched = matchedProvider.models[targetId]
		if (matched) return createModelConfig(matched, targetId)
	}

	for (const provider of Object.values(getPresetProviders())) {
		const matched = provider.models[targetId]
		if (matched) return createModelConfig(matched, targetId)
	}

	return undefined
}

export function listMissingPresetModelsForProvider(
	provider: AIProviderConfig,
): AIModelConfig[] {
	const matchedPreset = findPresetProviderByApi(provider.api)
	if (!matchedPreset) return []

	return Object.entries(matchedPreset.models)
		.filter(([modelId]) => !provider.models[modelId])
		.map(([modelId, model]) => createModelConfig(model, modelId))
}

export function createProviderFromPreset(
	preset: AIProviderDefinition,
	apiKey: string,
): AIProviderConfig {
	return {
		...preset,
		apiKey,
		allowBrowserCors: false,
		models: Object.fromEntries(
			Object.entries(preset.models).map(([modelId, model]) => [
				modelId,
				createModelConfig(model, modelId),
			]),
		),
	}
}
