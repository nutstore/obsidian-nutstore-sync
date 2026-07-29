import { createOpenAI } from '@ai-sdk/openai'
import {
	assertProviderApiKeyUsable,
	createProviderSettings,
	createResolvedLanguageModel,
} from './common'
import { OPENAI_DEFAULT_BASE_URL } from './defaults'
import type { AIProviderResolver } from './types'

export const openAIResponsesProviderResolver: AIProviderResolver = {
	assertUsable: assertProviderApiKeyUsable,
	createLanguageModel(provider, modelId) {
		assertProviderApiKeyUsable(provider)
		const settings = createProviderSettings(provider)
		const factory = createOpenAI({
			...settings,
			baseURL: settings.baseURL || OPENAI_DEFAULT_BASE_URL,
		})
		return createResolvedLanguageModel(provider, factory.responses(modelId))
	},
}
