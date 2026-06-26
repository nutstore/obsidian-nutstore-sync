import { createAnthropic } from '@ai-sdk/anthropic'
import {
	assertProviderApiKeyUsable,
	createProviderSettings,
	createResolvedLanguageModel,
} from './common'
import type { AIProviderResolver } from './types'

export const anthropicProviderResolver: AIProviderResolver = {
	assertUsable: assertProviderApiKeyUsable,
	createLanguageModel(provider, modelId) {
		assertProviderApiKeyUsable(provider)
		const factory = createAnthropic(createProviderSettings(provider))
		return createResolvedLanguageModel(provider, factory(modelId))
	},
}
