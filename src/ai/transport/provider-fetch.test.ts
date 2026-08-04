import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AIProviderConfig } from '~/ai/core/types'
import i18n from '~/i18n'
import { createProviderFetch } from './provider-fetch'

const provider = {
	id: 'provider-1',
	allowBrowserCors: true,
} as AIProviderConfig

describe('provider fetch', () => {
	afterEach(async () => {
		vi.unstubAllGlobals()
		await i18n.changeLanguage('en')
	})

	it.each([
		[
			'en',
			'Network connection unavailable. Check your connection and try again.',
		],
		['zh', '网络连接不可用，请检查网络后重试。'],
	])('reports a disconnected network in %s', async (language, message) => {
		await i18n.changeLanguage(language)
		vi.stubGlobal('navigator', { onLine: false })
		vi.stubGlobal(
			'fetch',
			vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
		)

		await expect(
			createProviderFetch(provider)('https://example.com'),
		).rejects.toThrow(message)
	})

	it('keeps the provider guidance for an online browser fetch failure', async () => {
		vi.stubGlobal('navigator', { onLine: true })
		vi.stubGlobal(
			'fetch',
			vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
		)

		await expect(
			createProviderFetch(provider)('https://example.com'),
		).rejects.toThrow('Browser CORS request failed.')
	})

	it('recognizes the Chromium disconnected error when navigator is unavailable', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockRejectedValue(new TypeError('net::ERR_INTERNET_DISCONNECTED')),
		)

		await expect(
			createProviderFetch(provider)('https://example.com'),
		).rejects.toThrow('Network connection unavailable.')
	})
})
