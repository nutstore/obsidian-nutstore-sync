export const PROVIDER_API_FORMAT_OPTIONS = [
	{
		value: '@ai-sdk/openai-compatible',
		labelKey: 'settings.ai.provider.apiFormat.openaiChatCompletions',
	},
	{
		value: '@ai-sdk/openai',
		labelKey: 'settings.ai.provider.apiFormat.openaiResponses',
	},
	{
		value: '@ai-sdk/anthropic',
		labelKey: 'settings.ai.provider.apiFormat.anthropic',
	},
] as const
