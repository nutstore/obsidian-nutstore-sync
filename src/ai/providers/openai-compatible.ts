import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
	assertProviderApiKeyUsable,
	createProviderSettings,
	createResolvedLanguageModel,
} from './common'
import { getProviderDefaultBaseURL } from './defaults'
import type { AIProviderResolver } from './types'
import type { AIProviderConfig } from '~/ai/core/types'
import i18n from '~/i18n'

function getBaseURL(provider: AIProviderConfig) {
	const configuredBaseURL = provider.api?.trim()
	if (configuredBaseURL) {
		return configuredBaseURL
	}
	return getProviderDefaultBaseURL(provider.npm)
}

function assertOpenAICompatibleProviderUsable(provider: AIProviderConfig) {
	assertProviderApiKeyUsable(provider)
	if (!getBaseURL(provider)) {
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
			baseURL: getBaseURL(provider)!,
		})
		return createResolvedLanguageModel(provider, factory.chatModel(modelId))
	},
}
