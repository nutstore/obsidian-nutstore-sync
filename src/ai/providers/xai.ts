import { createXai } from '@ai-sdk/xai'
import {
	assertProviderApiKeyUsable,
	createProviderSettings,
	createResolvedLanguageModel,
} from './common'
import type { AIProviderResolver } from './types'

export const xaiProviderResolver: AIProviderResolver = {
	assertUsable: assertProviderApiKeyUsable,
	createLanguageModel(provider, modelId) {
		assertProviderApiKeyUsable(provider)
		const factory = createXai(createProviderSettings(provider))
		return createResolvedLanguageModel(provider, factory(modelId))
	},
}
