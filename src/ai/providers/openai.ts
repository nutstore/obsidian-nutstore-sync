import { createOpenAI } from '@ai-sdk/openai'
import { wrapLanguageModel } from 'ai'
import type { AIProviderConfig } from '~/ai/core/types'
import { createProviderFetch } from '~/ai/transport/provider-fetch'
import { NUTSTORE_LLM_GATEWAY_PROVIDER_ID } from '~/consts'
import i18n from '~/i18n'
import type { AIProviderResolver } from './types'

function assertProviderUsable(provider: AIProviderConfig) {
	if (!provider.apiKey.trim()) {
		if (provider.id === NUTSTORE_LLM_GATEWAY_PROVIDER_ID) {
			throw new Error(
				i18n.t('settings.ai.nutstoreLlmGateway.errors.authorizationRequired'),
			)
		}
		throw new Error(i18n.t('chatbox.errors.apiKeyRequired'))
	}
}

export const openAIProviderResolver: AIProviderResolver = {
	assertUsable: assertProviderUsable,
	createLanguageModel(provider, modelId) {
		assertProviderUsable(provider)
		const factory = createOpenAI({
			name: provider.name,
			baseURL: provider.api,
			apiKey: provider.apiKey,
			fetch: createProviderFetch(provider),
		})

		return {
			model: wrapLanguageModel({
				model: factory.chat(modelId),
				middleware: [],
			}),
			providerName: provider.name,
		}
	},
}
