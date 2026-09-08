import type { FilePart, ModelMessage, TextPart, UserModelMessage } from 'ai'
import { getProviderResolver } from '../providers/registry'
import {
	AIModelConfig,
	AIModelProviderOverride,
	AIProviderConfig,
} from './types'

function resolveEffectiveProviderConfig(
	provider: AIProviderConfig,
	override?: AIModelProviderOverride,
): AIProviderConfig {
	if (!override?.npm && !override?.api) {
		return provider
	}
	return {
		...provider,
		npm: override.npm?.trim() || provider.npm,
		api: override.api?.trim() || provider.api,
	}
}

export function resolveLanguageModel(
	provider: AIProviderConfig,
	modelId: string,
) {
	const modelConfig = provider.models[modelId]
	const effectiveProvider = resolveEffectiveProviderConfig(
		provider,
		modelConfig?.provider,
	)
	const resolver = getProviderResolver(effectiveProvider)
	return resolver.createLanguageModel(effectiveProvider, modelId)
}

function inferFilePartModality(
	part: FilePart,
): AIModelConfig['modalities']['input'][number] | undefined {
	const mediaType = part.mediaType.toLowerCase()
	const topLevel = mediaType.split('/')[0]
	if (mediaType === 'image' || topLevel === 'image') return 'image'
	if (mediaType === 'audio' || topLevel === 'audio') return 'audio'
	if (mediaType === 'video' || topLevel === 'video') return 'video'
	if (mediaType === 'application/pdf') return 'pdf'
	return 'file'
}

function getPartModality(
	part: TextPart | FilePart | { type: 'image' },
): AIModelConfig['modalities']['input'][number] | undefined {
	switch (part.type) {
		case 'text':
			return 'text'
		case 'image':
			return 'image'
		case 'file':
			return inferFilePartModality(part)
		default:
			return undefined
	}
}

function createUnsupportedPartPlaceholder(
	part: TextPart | FilePart | { type: 'image' },
	modality: AIModelConfig['modalities']['input'][number] | undefined,
): TextPart {
	if (part.type === 'file') {
		const label = modality || part.mediaType || 'file'
		const filename = part.filename ? `: ${part.filename}` : ''
		return {
			type: 'text',
			text: `[${label} attached${filename}, unavailable to this model.]`,
		}
	}
	const label = modality || part.type
	return {
		type: 'text',
		text: `[${label} attached, unavailable to this model.]`,
	}
}

function adaptUserContentByModalities(
	content: UserModelMessage['content'],
	inputModalities: AIModelConfig['modalities']['input'],
): UserModelMessage['content'] {
	const allowed = new Set(inputModalities)
	if (typeof content === 'string') {
		return allowed.has('text') ? content : []
	}
	if (!Array.isArray(content)) {
		return content
	}
	return content.flatMap((part) => {
		const modality = getPartModality(part)
		const isGenericFileAllowed = part.type === 'file' && allowed.has('file')
		if ((modality && allowed.has(modality)) || isGenericFileAllowed) {
			return [part]
		}
		return allowed.has('text')
			? [createUnsupportedPartPlaceholder(part, modality)]
			: []
	})
}

function adaptMessagesByInputModalities(
	messages: ModelMessage[],
	inputModalities: AIModelConfig['modalities']['input'],
): ModelMessage[] {
	return messages.map((message) =>
		message.role === 'user'
			? {
					...message,
					content: adaptUserContentByModalities(
						message.content,
						inputModalities,
					),
				}
			: message,
	)
}

function mergeAdjacentUserMessages(messages: ModelMessage[]): ModelMessage[] {
	const merged: ModelMessage[] = []
	for (const message of messages) {
		const previous = merged[merged.length - 1]
		if (
			message.role === 'user' &&
			previous?.role === 'user' &&
			Array.isArray(previous.content) &&
			Array.isArray(message.content)
		) {
			previous.content = [...previous.content, ...message.content]
			continue
		}
		merged.push(
			message.role === 'user' && Array.isArray(message.content)
				? { ...message, content: [...message.content] }
				: message,
		)
	}
	return merged
}

export function prepareMessagesForModel(
	provider: AIProviderConfig,
	modelId: string,
	messages: ModelMessage[],
) {
	const inputModalities = provider.models[modelId]?.modalities?.input || [
		'text',
	]
	return mergeAdjacentUserMessages(
		adaptMessagesByInputModalities(messages, inputModalities),
	).filter((message) => message.role !== 'system')
}

export function assertProviderUsable(provider: AIProviderConfig) {
	getProviderResolver(provider).assertUsable(provider)
}
