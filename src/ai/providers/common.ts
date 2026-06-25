import { wrapLanguageModel } from 'ai'
import type { AIProviderConfig } from '~/ai/core/types'
import { createProviderFetch } from '~/ai/transport/provider-fetch'
import { NUTSTORE_LLM_GATEWAY_PROVIDER_ID } from '~/consts'
import i18n from '~/i18n'
import type { ResolvedLanguageModel } from './types'

type WrappableLanguageModel = Parameters<typeof wrapLanguageModel>[0]['model']

export function assertProviderApiKeyUsable(provider: AIProviderConfig) {
	if (provider.apiKey.trim()) {
		return
	}
	if (provider.id === NUTSTORE_LLM_GATEWAY_PROVIDER_ID) {
		throw new Error(
			i18n.t('settings.ai.nutstoreLlmGateway.errors.authorizationRequired'),
		)
	}
	throw new Error(i18n.t('chatbox.errors.apiKeyRequired'))
}

export function createProviderSettings(provider: AIProviderConfig) {
	return {
		name: provider.name,
		baseURL: provider.api,
		apiKey: provider.apiKey,
		fetch: createProviderFetch(provider),
	}
}

export function createResolvedLanguageModel(
	provider: AIProviderConfig,
	model: WrappableLanguageModel,
): ResolvedLanguageModel {
	return {
		model: wrapLanguageModel({
			model,
			middleware: [],
		}),
		providerName: provider.name,
	}
}
