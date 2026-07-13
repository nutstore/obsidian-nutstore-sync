import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
	assertProviderApiKeyUsable,
	createProviderSettings,
	createResolvedLanguageModel,
} from './common'
import type { AIProviderResolver } from './types'
import type { AIProviderConfig } from '~/ai/core/types'
import i18n from '~/i18n'

const OPENAI_BASE_URL = 'https://api.openai.com/v1'

function getBaseURL(provider: AIProviderConfig) {
	const configuredBaseURL = provider.api?.trim()
	if (configuredBaseURL) {
		return configuredBaseURL
	}
	return provider.npm === '@ai-sdk/openai' ? OPENAI_BASE_URL : undefined
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
