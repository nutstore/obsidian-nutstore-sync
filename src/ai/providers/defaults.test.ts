import { describe, expect, it } from 'vitest'
import {
	ANTHROPIC_DEFAULT_BASE_URL,
	GOOGLE_DEFAULT_BASE_URL,
	OPENAI_DEFAULT_BASE_URL,
	XAI_DEFAULT_BASE_URL,
	getProviderDefaultBaseURL,
} from './defaults'

describe('getProviderDefaultBaseURL', () => {
	it('returns the OpenAI default base URL for @ai-sdk/openai', () => {
		expect(getProviderDefaultBaseURL('@ai-sdk/openai')).toBe(
			OPENAI_DEFAULT_BASE_URL,
		)
	})

	it('returns the Anthropic default base URL for @ai-sdk/anthropic', () => {
		expect(getProviderDefaultBaseURL('@ai-sdk/anthropic')).toBe(
			ANTHROPIC_DEFAULT_BASE_URL,
		)
	})

	it('returns the Google default base URL for @ai-sdk/google', () => {
		expect(getProviderDefaultBaseURL('@ai-sdk/google')).toBe(
			GOOGLE_DEFAULT_BASE_URL,
		)
	})

	it('returns the xAI default base URL for @ai-sdk/xai', () => {
		expect(getProviderDefaultBaseURL('@ai-sdk/xai')).toBe(XAI_DEFAULT_BASE_URL)
	})

	it('returns undefined for the generic OpenAI-compatible package', () => {
		expect(
			getProviderDefaultBaseURL('@ai-sdk/openai-compatible'),
		).toBeUndefined()
	})

	it('returns undefined for an unknown npm package', () => {
		expect(getProviderDefaultBaseURL('@ai-sdk/groq')).toBeUndefined()
		expect(getProviderDefaultBaseURL('not-a-real-package')).toBeUndefined()
	})
})
