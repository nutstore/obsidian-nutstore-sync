import type { AIProviderConfig } from '~/ai/core/types'
import { openAIProviderResolver } from './openai'

export function getProviderResolver(_provider: AIProviderConfig) {
	return openAIProviderResolver
}
