import type { AIProviderConfig } from '~/ai/core/types'
import { anthropicProviderResolver } from './anthropic'
import { googleProviderResolver } from './google'
import { openAICompatibleProviderResolver } from './openai-compatible'
import { openAIProviderResolver } from './openai'
import { xaiProviderResolver } from './xai'

export function getProviderResolver(provider: AIProviderConfig) {
	switch (provider.npm) {
		case '@ai-sdk/openai-compatible':
			return openAICompatibleProviderResolver
		case '@ai-sdk/openai':
			return openAIProviderResolver
		case '@ai-sdk/anthropic':
			return anthropicProviderResolver
		case '@ai-sdk/google':
			return googleProviderResolver
		case '@ai-sdk/xai':
			return xaiProviderResolver
		default:
			return openAIProviderResolver
	}
}
