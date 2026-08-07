import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
	assertProviderApiKeyUsable,
	createProviderSettings,
	createResolvedLanguageModel,
} from './common'
import { XAI_DEFAULT_BASE_URL } from './defaults'
import type { AIProviderResolver } from './types'

export const xaiProviderResolver: AIProviderResolver = {
	assertUsable: assertProviderApiKeyUsable,
	createLanguageModel(provider, modelId) {
		assertProviderApiKeyUsable(provider)
		const settings = createProviderSettings(provider)
		const factory = createOpenAICompatible({
			...settings,
			baseURL: settings.baseURL || XAI_DEFAULT_BASE_URL,
		})
		return createResolvedLanguageModel(provider, factory.chatModel(modelId))
	},
}
