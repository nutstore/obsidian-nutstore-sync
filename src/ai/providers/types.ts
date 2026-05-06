import type { LanguageModel } from 'ai'
import type { AIMessage, AIProviderConfig } from '~/ai/types'

export interface ResolvedLanguageModel {
	model: LanguageModel
	providerName: string
}

export interface AIProviderResolver {
	assertUsable: (provider: AIProviderConfig) => void
	createLanguageModel: (
		provider: AIProviderConfig,
		modelId: string,
		context?: {
			messages?: AIMessage[]
			interleavedField?: string
		},
	) => ResolvedLanguageModel
}
