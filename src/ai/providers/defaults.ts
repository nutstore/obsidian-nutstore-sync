export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1'
export const GOOGLE_DEFAULT_BASE_URL =
	'https://generativelanguage.googleapis.com/v1beta'
export const XAI_DEFAULT_BASE_URL = 'https://api.x.ai/v1'

const DEFAULT_BASE_URLS = {
	'@ai-sdk/openai': OPENAI_DEFAULT_BASE_URL,
	'@ai-sdk/anthropic': ANTHROPIC_DEFAULT_BASE_URL,
	'@ai-sdk/google': GOOGLE_DEFAULT_BASE_URL,
	'@ai-sdk/xai': XAI_DEFAULT_BASE_URL,
} as const

export function getProviderDefaultBaseURL<
	K extends keyof typeof DEFAULT_BASE_URLS,
>(npm: K): (typeof DEFAULT_BASE_URLS)[K]
export function getProviderDefaultBaseURL(
	npm: string,
): (typeof DEFAULT_BASE_URLS)[keyof typeof DEFAULT_BASE_URLS] | undefined
export function getProviderDefaultBaseURL(npm: string): string | undefined {
	return (DEFAULT_BASE_URLS as Record<string, string | undefined>)[npm]
}
