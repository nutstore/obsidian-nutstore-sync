import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import {
	createModelConfig,
	createProviderConfig,
	createProviderFromPreset,
	findPresetModelById,
	sanitizeProviders,
} from './config'
import {
	aiProviderDefinitionsSchema,
	type AIProviderDefinition,
} from '../core/types'

describe('ai config', () => {
	it('matches the models-api provider catalog shape', () => {
		const catalog = JSON.parse(readFileSync('src/ai/models-api.json', 'utf8'))

		expect(aiProviderDefinitionsSchema.parse(catalog)).toBeTruthy()
	})

	it('creates an empty provider config', () => {
		const draft = createProviderConfig()

		expect(draft.npm).toBe('@ai-sdk/openai-compatible')
		expect(draft.models).toEqual({})
	})

	it('creates empty model configs without sharing mutable defaults', () => {
		const first = createModelConfig()
		const second = createModelConfig()

		first.modalities.input.push('image')
		first.limit.context = 128000

		expect(second.modalities.input).toEqual(['text'])
		expect(second.limit.context).toBe(0)
	})

	it('sanitizes provider objects', () => {
		const providers = sanitizeProviders({
			'provider-1': {
				id: 'provider-1',
				name: ' Provider ',
				apiKey: 'key',
				env: ['OPENAI_API_KEY'],
				npm: '@ai-sdk/openai-compatible',
				api: 'https://example.com/v1',
				doc: 'https://example.com/docs',
				models: {
					'model-1': {
						id: 'model-1',
						name: ' gpt-4.1 ',
						family: 'gpt',
						attachment: false,
						reasoning: true,
						tool_call: true,
						structured_output: true,
						temperature: true,
						release_date: '2025-01-01',
						last_updated: '2025-01-02',
						modalities: { input: ['text'], output: ['text'] },
						open_weights: false,
						cost: { input: 1, output: 2 },
						limit: { context: 128000, output: 16000 },
					},
				},
			},
		})

		expect(providers).toEqual({
			'provider-1': {
				id: 'provider-1',
				name: 'Provider',
				apiKey: 'key',
				env: ['OPENAI_API_KEY'],
				npm: '@ai-sdk/openai-compatible',
				api: 'https://example.com/v1',
				doc: 'https://example.com/docs',
				models: {
					'model-1': {
						id: 'model-1',
						name: 'gpt-4.1',
						family: 'gpt',
						attachment: false,
						reasoning: true,
						tool_call: true,
						structured_output: true,
						temperature: true,
						knowledge: undefined,
						release_date: '2025-01-01',
						last_updated: '2025-01-02',
						modalities: { input: ['text'], output: ['text'] },
						open_weights: false,
						cost: { input: 1, output: 2 },
						limit: { context: 128000, output: 16000 },
						interleaved: undefined,
						provider: undefined,
						status: undefined,
						experimental: undefined,
					},
				},
			},
		})
	})

	it('uses record keys as fallback ids', () => {
		const providers = sanitizeProviders({
			'provider-1': {
				name: 'Provider',
				models: {
					'model-1': {
						name: 'Model',
					},
				},
			},
		})

		expect(providers['provider-1'].id).toBe('provider-1')
		expect(providers['provider-1'].models['model-1'].id).toBe('model-1')
	})

	it('creates provider configs from presets without sharing model objects', () => {
		const preset: AIProviderDefinition = {
			id: 'provider-1',
			env: ['API_KEY'],
			npm: '@ai-sdk/openai-compatible',
			api: 'https://example.com/v1',
			name: 'Provider',
			doc: 'https://example.com/docs',
			models: {
				'model-1': {
					id: 'model-1',
					name: 'Model',
					attachment: false,
					reasoning: false,
					tool_call: true,
					temperature: true,
					release_date: '2025-01-01',
					last_updated: '2025-01-02',
					modalities: { input: ['text'], output: ['text'] },
					open_weights: false,
					limit: { context: 128000, output: 16000 },
				},
			},
		}

		const provider = createProviderFromPreset(preset, 'key')
		provider.models['model-1'].modalities.input.push('image')

		expect(provider.apiKey).toBe('key')
		expect(preset.models['model-1'].modalities.input).toEqual(['text'])
	})

	it('finds preset models by trimmed id', () => {
		const catalog = aiProviderDefinitionsSchema.parse(
			JSON.parse(readFileSync('src/ai/models-api.json', 'utf8')),
		)
		const firstProvider = Object.values(catalog)[0]
		const firstModel = Object.values(firstProvider.models)[0]

		expect(findPresetModelById(` ${firstModel.id} `)?.id).toBe(firstModel.id)
	})

	it('throws when providers value is not an object', () => {
		expect(() => sanitizeProviders('invalid')).toThrow(/Invalid AI provider/)
		expect(() => sanitizeProviders([{ name: 'Provider' }])).toThrow(
			/Invalid AI provider/,
		)
	})
})
