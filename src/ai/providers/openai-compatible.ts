import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
	assertProviderApiKeyUsable,
	createProviderSettings,
	createResolvedLanguageModel,
} from './common'
import type { AIProviderResolver } from './types'
import type { AIProviderConfig } from '~/ai/core/types'
import i18n from '~/i18n'

function assertOpenAICompatibleProviderUsable(provider: AIProviderConfig) {
	assertProviderApiKeyUsable(provider)
	if (!provider.api?.trim()) {
		throw new Error(i18n.t('chatbox.errors.providerBaseUrlRequired'))
	}
}

export const openAICompatibleProviderResolver: AIProviderResolver = {
	assertUsable: assertOpenAICompatibleProviderUsable,
	createLanguageModel(provider, modelId) {
		assertOpenAICompatibleProviderUsable(provider)
		const settings = createProviderSettings(provider)
		const factory = createOpenAICompatible({
			...settings,
			baseURL: settings.baseURL!,
		})
		return createResolvedLanguageModel(provider, factory.chatModel(modelId))
	},
}
