import { createOpenAI } from '@ai-sdk/openai'
import {
	assertProviderApiKeyUsable,
	createProviderSettings,
	createResolvedLanguageModel,
} from './common'
import type { AIProviderResolver } from './types'

export const openAIProviderResolver: AIProviderResolver = {
	assertUsable: assertProviderApiKeyUsable,
	createLanguageModel(provider, modelId) {
		assertProviderApiKeyUsable(provider)
		const factory = createOpenAI(createProviderSettings(provider))
		return createResolvedLanguageModel(provider, factory.chat(modelId))
	},
}
