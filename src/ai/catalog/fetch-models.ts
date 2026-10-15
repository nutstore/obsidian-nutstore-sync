import { createModelConfig, findPresetModelById } from '~/ai/catalog/config'
import type {
	AIModelConfig,
	AIModelModality,
	AIProviderConfig,
} from '~/ai/core/types'
import { getProviderDefaultBaseURL } from '~/ai/providers/defaults'
import { createProviderFetch } from '~/ai/transport/provider-fetch'
import i18n from '~/i18n'

export interface DiscoveredModel {
	id: string
	name: string
	description?: string
	modelConfig: AIModelConfig
}

const VALID_MODALITIES: Set<AIModelModality> = new Set([
	'text',
	'image',
	'audio',
	'video',
	'pdf',
	'file',
])

function normalizeModality(mod: string): AIModelModality | undefined {
	const lower = mod.trim().toLowerCase()
	if (VALID_MODALITIES.has(lower as AIModelModality)) {
		return lower as AIModelModality
	}
	if (lower === 'vision' || lower === 'img') return 'image'
	if (lower === 'document' || lower === 'doc') return 'pdf'
	if (lower === 'voice' || lower === 'sound') return 'audio'
	return undefined
}

function extractModalities(
	rec: Record<string, unknown>,
): { input: AIModelModality[]; output: AIModelModality[] } | undefined {
	const inputSet = new Set<AIModelModality>(['text'])
	let foundAny = false

	if (rec.modalities && typeof rec.modalities === 'object') {
		const mods = rec.modalities as Record<string, unknown>
		if (Array.isArray(mods.input)) {
			foundAny = true
			for (const m of mods.input) {
				if (typeof m === 'string') {
					const norm = normalizeModality(m)
					if (norm) inputSet.add(norm)
				}
			}
		}
	} else if (Array.isArray(rec.modalities)) {
		foundAny = true
		for (const m of rec.modalities) {
			if (typeof m === 'string') {
				const norm = normalizeModality(m)
				if (norm) inputSet.add(norm)
			}
		}
	}

	if (Array.isArray(rec.input_modalities)) {
		foundAny = true
		for (const m of rec.input_modalities) {
			if (typeof m === 'string') {
				const norm = normalizeModality(m)
				if (norm) inputSet.add(norm)
			}
		}
	}

	if (rec.architecture && typeof rec.architecture === 'object') {
		const arch = rec.architecture as Record<string, unknown>
		if (typeof arch.modality === 'string') {
			foundAny = true
			const parts = arch.modality.toLowerCase().split('->')[0].split('+')
			for (const p of parts) {
				const norm = normalizeModality(p)
				if (norm) inputSet.add(norm)
			}
		}
		if (Array.isArray(arch.input_modalities)) {
			foundAny = true
			for (const m of arch.input_modalities) {
				if (typeof m === 'string') {
					const norm = normalizeModality(m)
					if (norm) inputSet.add(norm)
				}
			}
		}
	}

	if (!foundAny) return undefined

	return {
		input: Array.from(inputSet),
		output: ['text'],
	}
}

function extractLimits(
	rec: Record<string, unknown>,
): { context: number; output: number; input?: number } | undefined {
	const rawContext =
		rec.context_window ??
		rec.context_length ??
		rec.max_context_tokens ??
		rec.inputTokenLimit ??
		(typeof rec.limits === 'object' && rec.limits !== null
			? (rec.limits as Record<string, unknown>).context
			: undefined) ??
		(typeof rec.limit === 'object' && rec.limit !== null
			? (rec.limit as Record<string, unknown>).context
			: undefined)

	const rawOutput =
		rec.max_output_tokens ??
		rec.max_tokens ??
		rec.max_completion_tokens ??
		rec.outputTokenLimit ??
		(typeof rec.limits === 'object' && rec.limits !== null
			? (rec.limits as Record<string, unknown>).output
			: undefined) ??
		(typeof rec.limit === 'object' && rec.limit !== null
			? (rec.limit as Record<string, unknown>).output
			: undefined)

	const rawInput =
		rec.max_input_tokens ??
		(typeof rec.limits === 'object' && rec.limits !== null
			? (rec.limits as Record<string, unknown>).input
			: undefined) ??
		(typeof rec.limit === 'object' && rec.limit !== null
			? (rec.limit as Record<string, unknown>).input
			: undefined)

	const context =
		typeof rawContext === 'number'
			? rawContext
			: rawContext
				? Number(rawContext)
				: undefined
	const output =
		typeof rawOutput === 'number'
			? rawOutput
			: rawOutput
				? Number(rawOutput)
				: undefined
	const input =
		typeof rawInput === 'number'
			? rawInput
			: rawInput
				? Number(rawInput)
				: undefined

	if (context === undefined && output === undefined) {
		return undefined
	}

	return {
		context: context && !isNaN(context) ? context : 0,
		output: output && !isNaN(output) ? output : 0,
		input: input && !isNaN(input) ? input : undefined,
	}
}

function extractReasoning(rec: Record<string, unknown>): boolean | undefined {
	if (typeof rec.reasoning === 'boolean') {
		return rec.reasoning
	}
	if (
		Array.isArray(rec.supported_reasoning_levels) &&
		rec.supported_reasoning_levels.length > 0
	) {
		return true
	}
	return undefined
}

export function resolvePresetModel(
	modelId: string,
	providerApi?: string,
): AIModelConfig | undefined {
	const direct = findPresetModelById(modelId, providerApi)
	if (direct) return direct

	const slashIndex = modelId.lastIndexOf('/')
	if (slashIndex !== -1) {
		const baseId = modelId.slice(slashIndex + 1).replace(/^~/, '')
		const matchedBase = findPresetModelById(baseId, providerApi)
		if (matchedBase) return matchedBase
	}

	const firstSlash = modelId.indexOf('/')
	if (firstSlash !== -1) {
		const subId = modelId.slice(firstSlash + 1).replace(/^~/, '')
		const matchedSub = findPresetModelById(subId, providerApi)
		if (matchedSub) return matchedSub
	}

	return undefined
}

function inferModelDefaults(modelId: string): {
	modalities?: { input: AIModelModality[]; output: AIModelModality[] }
	limit?: { context: number; output: number }
	reasoning?: boolean
} {
	const lower = modelId.toLowerCase()
	if (lower.includes('claude')) {
		return {
			modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
			limit: { context: 200000, output: 8192 },
			reasoning: lower.includes('3-7') || lower.includes('thinking'),
		}
	}
	if (lower.includes('gemini')) {
		return {
			modalities: {
				input: ['text', 'image', 'video', 'audio', 'pdf'],
				output: ['text'],
			},
			limit: { context: 1048576, output: 65536 },
			reasoning: true,
		}
	}
	if (
		lower.includes('gpt-4') ||
		lower.includes('gpt-5') ||
		lower.includes('gpt-6') ||
		lower.includes('codex')
	) {
		return {
			modalities: { input: ['text', 'image'], output: ['text'] },
			limit: { context: 128000, output: 16384 },
			reasoning:
				lower.includes('o1') ||
				lower.includes('o3') ||
				lower.includes('astra') ||
				lower.includes('sol'),
		}
	}
	if (lower.includes('deepseek')) {
		return {
			modalities: { input: ['text'], output: ['text'] },
			limit: { context: 64000, output: 8192 },
			reasoning: lower.includes('r1') || lower.includes('reasoner'),
		}
	}
	if (
		lower.includes('vision') ||
		lower.includes('vl') ||
		lower.includes('omni') ||
		lower.includes('5v') ||
		lower.includes('4v')
	) {
		return {
			modalities: { input: ['text', 'image'], output: ['text'] },
		}
	}
	return {}
}

function appendPathToUrl(rawUrl: string, pathSegment: string): string {
	try {
		const parsed = new URL(rawUrl)
		let pathname = parsed.pathname.replace(/\/+$/, '')
		const segment = pathSegment.startsWith('/')
			? pathSegment
			: `/${pathSegment}`
		if (!pathname.endsWith(segment)) {
			pathname = `${pathname}${segment}`
		}
		parsed.pathname = pathname
		return parsed.toString()
	} catch {
		const clean = rawUrl.replace(/\/+$/, '')
		const segment = pathSegment.startsWith('/')
			? pathSegment
			: `/${pathSegment}`
		if (clean.endsWith(segment)) return clean
		return `${clean}${segment}`
	}
}

export function resolveModelsRequest(provider: AIProviderConfig): {
	url: string
	headers: Record<string, string>
} {
	const rawBaseURL =
		provider.api?.trim() || getProviderDefaultBaseURL(provider.npm)
	if (!rawBaseURL) {
		throw new Error(i18n.t('chatbox.errors.providerBaseUrlRequired'))
	}

	const apiKey = provider.apiKey?.trim()

	if (provider.npm === '@ai-sdk/anthropic') {
		const clean = rawBaseURL.replace(/\/+$/, '')
		const path = clean.endsWith('/v1') ? '/models' : '/v1/models'
		const url = appendPathToUrl(rawBaseURL, path)

		const headers: Record<string, string> = {
			Accept: 'application/json',
			'anthropic-version': '2023-06-01',
		}
		if (apiKey) {
			headers['x-api-key'] = apiKey
			headers['Authorization'] = `Bearer ${apiKey}`
		}
		return { url, headers }
	}

	if (provider.npm === '@ai-sdk/google') {
		const clean = rawBaseURL.replace(/\/+$/, '')
		const path =
			clean.endsWith('/v1beta') || clean.endsWith('/v1')
				? '/models'
				: '/v1beta/models'
		let url = appendPathToUrl(rawBaseURL, path)

		const headers: Record<string, string> = {
			Accept: 'application/json',
		}
		if (apiKey) {
			headers['x-goog-api-key'] = apiKey
			try {
				const parsed = new URL(url)
				if (!parsed.searchParams.has('key')) {
					parsed.searchParams.set('key', apiKey)
					url = parsed.toString()
				}
			} catch {
				const separator = url.includes('?') ? '&' : '?'
				url = `${url}${separator}key=${encodeURIComponent(apiKey)}`
			}
		}
		return { url, headers }
	}

	// OpenAI Responses, OpenAI Compatible, xAI, etc.
	const url = appendPathToUrl(rawBaseURL, '/models')
	const headers: Record<string, string> = {
		Accept: 'application/json',
	}
	if (apiKey) {
		headers['Authorization'] = `Bearer ${apiKey}`
	}
	return { url, headers }
}

export function parseModelsResponse(
	payload: unknown,
	providerApi?: string,
): DiscoveredModel[] {
	if (!payload || typeof payload !== 'object') {
		return []
	}

	let rawList: unknown[] = []
	if (Array.isArray(payload)) {
		rawList = payload
	} else {
		const record = payload as Record<string, unknown>
		if (Array.isArray(record.data)) {
			rawList = record.data
		} else if (Array.isArray(record.models)) {
			rawList = record.models
		} else if (Array.isArray(record.items)) {
			rawList = record.items
		}
	}

	const seen = new Set<string>()
	const results: DiscoveredModel[] = []

	for (const item of rawList) {
		if (typeof item === 'string') {
			const id = item.trim()
			if (!id || seen.has(id)) continue
			seen.add(id)

			const preset = resolvePresetModel(id, providerApi)
			const inferred = inferModelDefaults(id)
			const modalities = preset?.modalities ||
				inferred.modalities || { input: ['text'], output: ['text'] }
			const limit = preset?.limit || inferred.limit || { context: 0, output: 0 }
			const reasoning = preset?.reasoning ?? inferred.reasoning ?? false
			const attachment = modalities.input.some((m) => m !== 'text')

			const modelConfig = createModelConfig(
				{
					...(preset || {}),
					id,
					name: preset?.name || id,
					modalities,
					limit,
					reasoning,
					attachment,
				},
				id,
			)

			results.push({ id, name: id, modelConfig })
			continue
		}

		if (item && typeof item === 'object') {
			const rec = item as Record<string, unknown>
			let rawId =
				typeof rec.id === 'string'
					? rec.id
					: typeof rec.name === 'string'
						? rec.name
						: typeof rec.model === 'string'
							? rec.model
							: undefined

			if (!rawId) continue
			rawId = rawId.trim()
			const id = rawId.startsWith('models/')
				? rawId.slice('models/'.length)
				: rawId
			if (!id || seen.has(id)) continue
			seen.add(id)

			const rawName =
				typeof rec.display_name === 'string'
					? rec.display_name
					: typeof rec.displayName === 'string'
						? rec.displayName
						: typeof rec.name === 'string'
							? rec.name
							: undefined

			const name = rawName?.trim() || id
			const description =
				typeof rec.description === 'string' ? rec.description.trim() : undefined

			const apiModalities = extractModalities(rec)
			const apiLimits = extractLimits(rec)
			const apiReasoning = extractReasoning(rec)
			const preset = resolvePresetModel(id, providerApi)
			const inferred = inferModelDefaults(id)

			const modalities = apiModalities ||
				preset?.modalities ||
				inferred.modalities || { input: ['text'], output: ['text'] }

			const limit = apiLimits ||
				preset?.limit ||
				inferred.limit || { context: 0, output: 0 }

			const reasoning =
				apiReasoning ?? preset?.reasoning ?? inferred.reasoning ?? false

			const attachment = modalities.input.some((m) => m !== 'text')

			const modelConfig = createModelConfig(
				{
					...(preset || {}),
					id,
					name,
					modalities,
					limit,
					reasoning,
					attachment,
					tool_call:
						typeof rec.tool_call === 'boolean'
							? rec.tool_call
							: (preset?.tool_call ?? true),
				},
				id,
			)

			results.push({ id, name, description, modelConfig })
		}
	}

	return results
}

export async function fetchProviderModels(
	provider: AIProviderConfig,
	options: { signal?: AbortSignal } = {},
): Promise<DiscoveredModel[]> {
	const { url, headers } = resolveModelsRequest(provider)
	const fetchImpl = createProviderFetch(provider)

	const response = await fetchImpl(url, {
		method: 'GET',
		headers,
		signal: options.signal,
	})

	if (!response.ok) {
		let errorDetail = ''
		try {
			const errorJson = (await response.json()) as unknown
			if (errorJson && typeof errorJson === 'object') {
				const rec = errorJson as Record<string, unknown>
				const err = rec.error
				if (typeof err === 'string') {
					errorDetail = err
				} else if (
					err &&
					typeof err === 'object' &&
					typeof (err as Record<string, unknown>).message === 'string'
				) {
					errorDetail = (err as Record<string, unknown>).message as string
				} else if (typeof rec.message === 'string') {
					errorDetail = rec.message
				}
			}
		} catch {
			// Ignore json error
		}
		const statusText = response.statusText ? ` ${response.statusText}` : ''
		const message = errorDetail
			? `HTTP ${response.status}${statusText}: ${errorDetail}`
			: `HTTP ${response.status}${statusText}`
		throw new Error(message)
	}

	const payload = (await response.json()) as unknown
	return parseModelsResponse(payload, provider.api)
}
