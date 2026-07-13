import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
	assertProviderApiKeyUsable,
	createProviderSettings,
	createResolvedLanguageModel,
} from './common'
import type { AIProviderResolver } from './types'

const XAI_API_BASE_URL = 'https://api.x.ai/v1'

export const xaiProviderResolver: AIProviderResolver = {
	assertUsable: assertProviderApiKeyUsable,
	createLanguageModel(provider, modelId) {
		assertProviderApiKeyUsable(provider)
		const settings = createProviderSettings(provider)
		const factory = createOpenAICompatible({
			...settings,
			baseURL: settings.baseURL || XAI_API_BASE_URL,
		})
		return createResolvedLanguageModel(provider, factory.chatModel(modelId))
	},
}
