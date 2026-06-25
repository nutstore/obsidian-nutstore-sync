import type { AIProviderConfig } from '~/ai/core/types'
import { anthropicProviderResolver } from './anthropic'
import { openAIProviderResolver } from './openai'

export function getProviderResolver(provider: AIProviderConfig) {
	if (provider.npm === '@ai-sdk/anthropic') {
		return anthropicProviderResolver
	}
	return openAIProviderResolver
}
