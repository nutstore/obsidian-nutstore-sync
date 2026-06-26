import type {
	AssistantModelMessage,
	FilePart,
	ImagePart,
	TextPart,
	UserModelMessage,
} from 'ai'
import { tool as aiTool, stepCountIs, streamText } from 'ai'
import { getProviderResolver } from '../providers/registry'
import {
	AIModelConfig,
	AIMessage,
	AIMessageMeta,
	AIProviderConfig,
	AIModelProviderOverride,
	AIToolDefinition,
} from './types'

export interface GenerateAssistantTurnRequest {
	provider: AIProviderConfig
	model: string
	messages: AIMessage[]
	tools: AIToolDefinition[]
	temperature?: number
	maxTokens?: number
	abortSignal?: AbortSignal
}

export interface GenerateAssistantTurnResult {
	message: AIMessage
	meta: AIMessageMeta
}

export interface GenerateAssistantTurnCallbacks {
	onTextDelta?: (delta: string) => void | Promise<void>
}

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

function inferFilePartModality(
	part: FilePart,
): AIModelConfig['modalities']['input'][number] | undefined {
	const mediaType = part.mediaType.toLowerCase()
	if (mediaType.startsWith('image/')) return 'image'
	if (mediaType.startsWith('audio/')) return 'audio'
	if (mediaType.startsWith('video/')) return 'video'
	if (mediaType === 'application/pdf') return 'pdf'
	return undefined
}

function getPartModality(
	part: TextPart | ImagePart | FilePart,
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
	part: TextPart | ImagePart | FilePart,
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
		if (modality && allowed.has(modality)) {
			return [part]
		}
		return allowed.has('text')
			? [createUnsupportedPartPlaceholder(part, modality)]
			: []
	})
}

function adaptMessagesByInputModalities(
	messages: AIMessage[],
	inputModalities: AIModelConfig['modalities']['input'],
): AIMessage[] {
	return messages.map((message) =>
		message.role === 'user'
			? {
					...message,
					content: adaptUserContentByModalities(
						message.content as UserModelMessage['content'],
						inputModalities,
					),
				}
			: message,
	) as AIMessage[]
}

function mergeAdjacentUserMessages(messages: AIMessage[]): AIMessage[] {
	const merged: AIMessage[] = []
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

function toAISDKTools(tools: AIToolDefinition[]) {
	return Object.fromEntries(
		tools.map((toolDefinition) => [
			toolDefinition.name,
			aiTool({
				description: toolDefinition.description,
				inputSchema: toolDefinition.inputSchema,
			}),
		]),
	)
}

export function assertProviderUsable(provider: AIProviderConfig) {
	getProviderResolver(provider).assertUsable(provider)
}

export async function generateAssistantTurn(
	request: GenerateAssistantTurnRequest,
	callbacks?: GenerateAssistantTurnCallbacks,
): Promise<GenerateAssistantTurnResult> {
	const modelConfig = request.provider.models[request.model]
	const provider = resolveEffectiveProviderConfig(
		request.provider,
		modelConfig?.provider,
	)
	const resolver = getProviderResolver(provider)
	const modelName =
		modelConfig?.name?.trim() || request.model
	const inputModalities = modelConfig?.modalities.input || ['text']
	const messages = mergeAdjacentUserMessages(
		adaptMessagesByInputModalities(request.messages, inputModalities),
	)
	const { model, providerName } = resolver.createLanguageModel(
		provider,
		request.model,
	)
	let streamError: unknown
	const result = streamText({
		model,
		messages: messages,
		tools: toAISDKTools(request.tools),
		stopWhen: stepCountIs(1),
		abortSignal: request.abortSignal,
		temperature: request.temperature,
		maxOutputTokens: request.maxTokens,
		onError: ({ error }) => {
			streamError = error
		},
		onChunk: async ({ chunk }) => {
			if (chunk.type === 'text-delta' && chunk.text) {
				await callbacks?.onTextDelta?.(chunk.text)
			}
		},
	})
	await result.consumeStream()
	if (streamError) {
		throw streamError
	}

	const text = await result.text
	const reasoning = await result.reasoning
	const toolCalls = await result.toolCalls
	const usage = await result.totalUsage
	const finishReason = await result.finishReason
	const response = await result.response

	const content: AssistantModelMessage['content'] = [
		...reasoning.map((r) => ({ type: 'reasoning' as const, text: r.text })),
		...(text ? [{ type: 'text' as const, text }] : []),
		...toolCalls,
	]
	const message: AssistantModelMessage = { role: 'assistant', content }

	return {
		message,
		meta: {
			providerId: request.provider.id,
			providerName: request.provider.name || providerName,
			modelId: response.modelId,
			modelName,
			usage,
			finishReason,
			responseId: response.id,
		},
	}
}
