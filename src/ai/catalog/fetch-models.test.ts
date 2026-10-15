// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

vi.mock('obsidian', () => {
	class HostClass {}
	return {
		Platform: { isWin: false, isMacOS: true, isLinux: false },
		Notice: HostClass,
		Modal: HostClass,
		Setting: HostClass,
		requestUrl: vi.fn(),
	}
})
vi.mock('~/i18n', () => ({ default: { t: (key: string) => key } }))

import { createProviderConfig } from './config'
import {
	fetchProviderModels,
	parseModelsResponse,
	resolveModelsRequest,
} from './fetch-models'

describe('fetch-models', () => {
	describe('resolveModelsRequest', () => {
		it('resolves OpenAI endpoint and headers with apiKey', () => {
			const provider = createProviderConfig({
				id: 'openai-test',
				name: 'OpenAI Test',
				npm: '@ai-sdk/openai',
				api: 'http://127.0.0.1:3425/v1',
				apiKey: 'sk-secret-token',
			})

			const req = resolveModelsRequest(provider)
			expect(req.url).toBe('http://127.0.0.1:3425/v1/models')
			expect(req.headers['Authorization']).toBe('Bearer sk-secret-token')
			expect(req.headers['Accept']).toBe('application/json')
		})

		it('preserves query parameters and avoids duplicate /models suffix', () => {
			const provider = createProviderConfig({
				id: 'custom-proxy',
				name: 'Custom Proxy',
				npm: '@ai-sdk/openai-compatible',
				api: 'https://gateway.example.com/api/v1/models?env=prod',
				apiKey: 'token-abc',
			})

			const req = resolveModelsRequest(provider)
			expect(req.url).toBe('https://gateway.example.com/api/v1/models?env=prod')
			expect(req.headers['Authorization']).toBe('Bearer token-abc')
		})

		it('resolves Anthropic endpoint with x-api-key and version headers', () => {
			const providerWithV1 = createProviderConfig({
				id: 'anthropic-test',
				name: 'Anthropic Test',
				npm: '@ai-sdk/anthropic',
				api: 'https://api.anthropic.com/v1',
				apiKey: 'ant-key-123',
			})

			const req = resolveModelsRequest(providerWithV1)
			expect(req.url).toBe('https://api.anthropic.com/v1/models')
			expect(req.headers['x-api-key']).toBe('ant-key-123')
			expect(req.headers['anthropic-version']).toBe('2023-06-01')

			const providerWithoutV1 = createProviderConfig({
				...providerWithV1,
				api: 'https://api.anthropic.com',
			})
			const req2 = resolveModelsRequest(providerWithoutV1)
			expect(req2.url).toBe('https://api.anthropic.com/v1/models')
		})

		it('resolves Google endpoint with x-goog-api-key and query param', () => {
			const provider = createProviderConfig({
				id: 'google-test',
				name: 'Google Test',
				npm: '@ai-sdk/google',
				api: 'https://generativelanguage.googleapis.com',
				apiKey: 'goog-key-456',
			})

			const req = resolveModelsRequest(provider)
			expect(req.url).toBe(
				'https://generativelanguage.googleapis.com/v1beta/models?key=goog-key-456',
			)
			expect(req.headers['x-goog-api-key']).toBe('goog-key-456')
		})

		it('throws when baseUrl is not available', () => {
			const provider = createProviderConfig({
				id: 'no-url',
				name: 'No URL',
				npm: '@ai-sdk/openai-compatible',
				api: undefined,
				apiKey: '',
			})

			expect(() => resolveModelsRequest(provider)).toThrow()
		})
	})

	describe('parseModelsResponse', () => {
		it('extracts rich modalities, context window, output limit, and reasoning from endpoint response', () => {
			const payload = {
				object: 'list',
				data: [
					{
						id: 'ns/google/gemini-4-argon',
						display_name: 'Gemini 4 Argon',
						context_window: 1048576,
						max_output_tokens: 65536,
						modalities: {
							input: ['text', 'image', 'video', 'audio', 'pdf'],
							output: ['text'],
						},
						reasoning: true,
					},
					{
						id: 'ns/anthropic/claude-haiku-5.5',
						display_name: 'Claude Haiku 5.5',
						context_length: 1000000,
						max_output_tokens: 128000,
						modalities: {
							input: ['text', 'image', 'pdf'],
							output: ['text'],
						},
						reasoning: true,
					},
					{
						id: 'ns/语言模型/🌟-pro-latest',
						name: '通用智能模型 🌟',
						input_modalities: ['text', 'image'],
						context_window: 262144,
						max_tokens: 8192,
					},
				],
			}

			const parsed = parseModelsResponse(payload)
			expect(parsed.length).toBe(3)

			const gemini = parsed[0]
			expect(gemini.id).toBe('ns/google/gemini-4-argon')
			expect(gemini.name).toBe('Gemini 4 Argon')
			expect(gemini.modelConfig.modalities.input).toEqual([
				'text',
				'image',
				'video',
				'audio',
				'pdf',
			])
			expect(gemini.modelConfig.limit.context).toBe(1048576)
			expect(gemini.modelConfig.limit.output).toBe(65536)
			expect(gemini.modelConfig.reasoning).toBe(true)
			expect(gemini.modelConfig.attachment).toBe(true)

			const claude = parsed[1]
			expect(claude.id).toBe('ns/anthropic/claude-haiku-5.5')
			expect(claude.name).toBe('Claude Haiku 5.5')
			expect(claude.modelConfig.modalities.input).toEqual([
				'text',
				'image',
				'pdf',
			])
			expect(claude.modelConfig.limit.context).toBe(1000000)
			expect(claude.modelConfig.limit.output).toBe(128000)
			expect(claude.modelConfig.attachment).toBe(true)

			const chinese = parsed[2]
			expect(chinese.id).toBe('ns/语言模型/🌟-pro-latest')
			expect(chinese.name).toBe('通用智能模型 🌟')
			expect(chinese.modelConfig.modalities.input).toEqual(['text', 'image'])
			expect(chinese.modelConfig.limit.context).toBe(262144)
			expect(chinese.modelConfig.limit.output).toBe(8192)
		})

		it('parses Google format and strips models/ prefix', () => {
			const payload = {
				models: [
					{
						name: 'models/gemini-2.0-flash',
						displayName: 'Gemini 2.0 Flash',
						inputTokenLimit: 1048576,
						outputTokenLimit: 8192,
					},
				],
			}

			const parsed = parseModelsResponse(payload)
			expect(parsed.length).toBe(1)
			expect(parsed[0].id).toBe('gemini-2.0-flash')
			expect(parsed[0].name).toBe('Gemini 2.0 Flash')
			expect(parsed[0].modelConfig.limit.context).toBe(1048576)
			expect(parsed[0].modelConfig.limit.output).toBe(8192)
		})

		it('parses array of strings without duplication', () => {
			const payload = ['gpt-4o', 'gpt-4o', 'claude-opus']
			const parsed = parseModelsResponse(payload)
			expect(parsed.map((p) => p.id)).toEqual(['gpt-4o', 'claude-opus'])
		})

		it('returns empty array for invalid payloads', () => {
			expect(parseModelsResponse(null)).toEqual([])
			expect(parseModelsResponse(undefined)).toEqual([])
			expect(parseModelsResponse('not-an-object')).toEqual([])
			expect(parseModelsResponse({})).toEqual([])
		})
	})

	describe('fetchProviderModels', () => {
		it('fetches and parses models successfully', async () => {
			const provider = createProviderConfig({
				id: 'test-prov',
				name: 'Test Prov',
				npm: '@ai-sdk/openai-compatible',
				api: 'http://127.0.0.1:3425/v1',
				apiKey: 'sk-123',
				allowBrowserCors: true,
			})

			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					data: [
						{
							id: 'model-alpha',
							name: 'Model Alpha',
							context_window: 128000,
							max_output_tokens: 4096,
							modalities: { input: ['text', 'image'], output: ['text'] },
						},
					],
				}),
			})
			vi.stubGlobal('fetch', mockFetch)

			const result = await fetchProviderModels(provider)
			expect(result.length).toBe(1)
			expect(result[0].id).toBe('model-alpha')
			expect(result[0].modelConfig.modalities.input).toEqual(['text', 'image'])
			expect(result[0].modelConfig.limit.context).toBe(128000)
			expect(result[0].modelConfig.limit.output).toBe(4096)
			vi.unstubAllGlobals()
		})

		it('throws on non-200 HTTP response', async () => {
			const provider = createProviderConfig({
				id: 'test-prov',
				name: 'Test Prov',
				npm: '@ai-sdk/openai-compatible',
				api: 'http://127.0.0.1:3425/v1',
				apiKey: 'sk-123',
				allowBrowserCors: true,
			})

			const mockFetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
				statusText: 'Unauthorized',
				json: async () => ({
					error: { message: 'Invalid API Key provided' },
				}),
			})
			vi.stubGlobal('fetch', mockFetch)

			await expect(fetchProviderModels(provider)).rejects.toThrow(
				'HTTP 401 Unauthorized: Invalid API Key provided',
			)
			vi.unstubAllGlobals()
		})
	})
})
