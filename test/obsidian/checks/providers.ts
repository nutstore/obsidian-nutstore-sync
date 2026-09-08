import { assert } from './assert'

export async function createsProviderModels() {
	const { getProviderResolver } = await import('~/ai/providers/registry')
	const provider = (overrides: Record<string, unknown> = {}) =>
		({
			id: 'neutral-provider',
			env: [],
			npm: '@ai-sdk/openai-compatible',
			api: 'https://example.test/v1',
			name: 'neutral provider',
			doc: '',
			apiKey: 'neutral-key',
			models: {},
			...overrides,
		}) as never
	const compatible = provider()
	assert(
		getProviderResolver(compatible).createLanguageModel(
			compatible,
			'neutral-model',
		).model.constructor.name === '_OpenAICompatibleChatLanguageModel',
		'OpenAI-compatible provider did not create its expected model',
	)
	const official = provider({ npm: '@ai-sdk/openai', api: undefined })
	assert(
		getProviderResolver(official).createLanguageModel(official, 'neutral-model')
			.model.constructor.name === '_OpenAIResponsesLanguageModel',
		'Official OpenAI provider did not create its expected model',
	)
}
