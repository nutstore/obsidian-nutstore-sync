import { describe, expect, it } from 'vitest'
import type { AIProviderConfig } from '~/ai/core/types'
import { getProviderResolver } from './registry'

function createProvider(
	overrides: Partial<AIProviderConfig> = {},
): AIProviderConfig {
	return {
		id: 'provider-1',
		env: [],
		npm: '@ai-sdk/openai-compatible',
		api: 'https://example.com/v1',
		name: 'example',
		doc: '',
		apiKey: 'key',
		models: {},
		...overrides,
	}
}

describe('getProviderResolver', () => {
	it('uses the OpenAI-compatible resolver for OpenAI-compatible providers', () => {
		const resolver = getProviderResolver(createProvider())
		const { model } = resolver.createLanguageModel(createProvider(), 'model-1')

		expect(model.constructor.name).toBe('_OpenAICompatibleChatLanguageModel')
	})

	it('uses the OpenAI Responses resolver for official OpenAI providers', () => {
		const provider = createProvider({
			api: undefined,
			npm: '@ai-sdk/openai',
			name: 'OpenAI',
		})
		const resolver = getProviderResolver(provider)
		const { model } = resolver.createLanguageModel(provider, 'model-1')

		expect(model.constructor.name).toBe('_OpenAIResponsesLanguageModel')
	})

	it('uses the OpenAI-compatible resolver and default endpoint for xAI', () => {
		const provider = createProvider({
			api: undefined,
			npm: '@ai-sdk/xai',
			name: 'xAI',
		})
		const resolver = getProviderResolver(provider)
		const { model } = resolver.createLanguageModel(provider, 'grok-3')

		expect(model.constructor.name).toBe('_OpenAICompatibleChatLanguageModel')
	})

	it('rejects OpenAI-compatible providers without a base URL before model creation', () => {
		const resolver = getProviderResolver(
			createProvider({
				api: undefined,
			}),
		)

		expect(() =>
			resolver.assertUsable(
				createProvider({
					api: undefined,
				}),
			),
		).toThrow('The selected OpenAI-compatible provider is missing a base URL')
	})
})
