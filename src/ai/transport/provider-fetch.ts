import {
	createInterleavedMessageFieldFetch,
	type FetchFunction,
} from '~/ai/interleaved-message-field'
import type { AIMessage, AIProviderConfig } from '~/ai/types'
import i18n from '~/i18n'
import { obsidianFetch } from './obsidian-fetch'

function isBrowserCorsFailure(error: unknown) {
	return error instanceof TypeError
}

function buildDisableCorsLink(providerId: string) {
	return `obsidian://nutstore-sync/modal/provider-edit?providerId=${encodeURIComponent(providerId)}`
}

export function createProviderFetch(
	provider: AIProviderConfig,
	options?: {
		messages?: Iterable<AIMessage>
		interleavedField?: string
	},
): FetchFunction {
	const baseFetch: FetchFunction = provider.allowBrowserCors
		? (input, init) => fetch(input, init)
		: obsidianFetch
	const wrappedFetch = createInterleavedMessageFieldFetch(
		baseFetch,
		options?.messages,
		options?.interleavedField,
	)

	if (!provider.allowBrowserCors) {
		return wrappedFetch
	}

	return async (input, init) => {
		try {
			return await wrappedFetch(input, init)
		} catch (error) {
			if (!isBrowserCorsFailure(error)) {
				throw error
			}
			throw new Error(
				i18n.t('settings.ai.errors.browserCorsFailedWithDisableLink', {
					link: buildDisableCorsLink(provider.id),
				}),
				{ cause: error },
			)
		}
	}
}
