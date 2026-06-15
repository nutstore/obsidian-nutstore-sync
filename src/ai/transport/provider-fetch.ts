import type { AIProviderConfig } from '~/ai/types'
import i18n from '~/i18n'
import { obsidianFetch } from './obsidian-fetch'

export type FetchFunction = typeof fetch

function isBrowserCorsFailure(error: unknown) {
	return error instanceof TypeError
}

function buildDisableCorsLink(providerId: string) {
	return `obsidian://nutstore-sync/modal/provider-edit?providerId=${encodeURIComponent(providerId)}`
}

export function createProviderFetch(provider: AIProviderConfig): FetchFunction {
	const baseFetch: FetchFunction = provider.allowBrowserCors
		? fetch
		: obsidianFetch

	if (!provider.allowBrowserCors) {
		return baseFetch
	}

	return async (input, init) => {
		try {
			return await baseFetch(input, init)
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
