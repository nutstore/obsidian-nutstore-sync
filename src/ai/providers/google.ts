import { createGoogle } from '@ai-sdk/google'
import {
	assertProviderApiKeyUsable,
	createProviderSettings,
	createResolvedLanguageModel,
} from './common'
import type { AIProviderResolver } from './types'

export const googleProviderResolver: AIProviderResolver = {
	assertUsable: assertProviderApiKeyUsable,
	createLanguageModel(provider, modelId) {
		assertProviderApiKeyUsable(provider)
		const factory = createGoogle(createProviderSettings(provider))
		return createResolvedLanguageModel(provider, factory(modelId))
	},
}
