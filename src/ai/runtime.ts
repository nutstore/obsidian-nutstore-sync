import type { ModelMessage } from 'ai'
import { streamText, tool as aiTool, stepCountIs } from 'ai'
import { getInterleavedMessageField } from './interleaved-message-field'
import { getProviderResolver } from './providers/registry'
import {
	AIMessage,
	AIMessageContentPart,
	AIMessageMeta,
	AIProviderConfig,
	AIToolDefinition,
} from './types'

export interface GenerateAssistantTurnRequest {
	provider: AIProviderConfig
	model: string
	messages: AIMessage[]
	tools: AIToolDefinition[]
	temperature?: number
	maxTokens?: number
}

export interface GenerateAssistantTurnResult {
	message: AIMessage
	meta: AIMessageMeta
}

export interface GenerateAssistantTurnCallbacks {
	onTextDelta?: (delta: string) => void | Promise<void>
}

function toTextParts(text?: string | null): AIMessageContentPart[] | null {
	if (!text) {
		return null
	}
	return [{ type: 'text', text }]
}

function mergeAdjacentUserMessages(messages: AIMessage[]): AIMessage[] {
	const merged: AIMessage[] = []
	for (const message of messages) {
		const previous = merged[merged.length - 1]
		if (message.role === 'user' && previous?.role === 'user') {
			previous.content = [...previous.content, ...message.content]
			continue
		}
		merged.push(
			message.role === 'user'
				? { ...message, content: [...message.content] }
				: message,
		)
	}
	return merged
}

function toModelMessages(messages: AIMessage[]): ModelMessage[] {
	return messages.map((message) => {
		switch (message.role) {
			case 'system':
				return {
					role: 'system',
					content: message.content
						.filter(
							(part): part is Extract<AIMessageContentPart, { type: 'text' }> =>
								part.type === 'text',
						)
						.map((part) => part.text)
						.join('\n'),
				}
			case 'user': {
				const content = message.content.map((part) => {
					if (part.type === 'image_url') {
						return {
							type: 'image' as const,
							image: new URL(part.image_url.url),
						}
					}
					return {
						type: 'text' as const,
						text: part.type === 'text' ? part.text : JSON.stringify(part.value),
					}
				})
				return {
					role: 'user',
					content,
				}
			}
			case 'assistant': {
				const content = [
					...(message.content || []).map((part) => ({
						type: 'text' as const,
						text: part.type === 'text' ? part.text : JSON.stringify(part),
					})),
					...(message.tool_calls || []).map((toolCall) => ({
						type: 'tool-call' as const,
						toolCallId: toolCall.id,
						toolName: toolCall.function.name,
						input: JSON.parse(toolCall.function.arguments || '{}'),
					})),
				]
				return {
					role: 'assistant',
					content,
				}
			}
			case 'tool':
				return {
					role: 'tool',
					content: [
						{
							type: 'tool-result' as const,
							toolCallId: message.tool_call_id,
							toolName: message.name,
							output: {
								type: 'text' as const,
								value: message.content
									.filter(
										(
											part,
										): part is Extract<
											AIMessageContentPart,
											{ type: 'text' }
										> => part.type === 'text',
									)
									.map((part) => part.text)
									.join('\n'),
							},
						},
					],
				}
		}
	})
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

function toAssistantMessage(
	result: {
		text: string
		toolCalls: Array<{
			toolCallId: string
			toolName: string
			input?: unknown
		}>
	},
	interleaved?: {
		field: string
		value: unknown
	},
): AIMessage {
	const toolCalls = result.toolCalls.map((toolCall) => ({
		id: toolCall.toolCallId,
		type: 'function' as const,
		function: {
			name: toolCall.toolName,
			arguments: JSON.stringify(toolCall.input ?? {}),
		},
	}))

	const message: AIMessage =
		toolCalls.length > 0
			? {
					role: 'assistant',
					content: toTextParts(result.text),
					tool_calls: toolCalls,
				}
			: {
					role: 'assistant',
					content: toTextParts(result.text) || [],
				}

	if (
		interleaved &&
		message.role === 'assistant' &&
		interleaved.value !== undefined
	) {
		message.interleaved = { [interleaved.field]: interleaved.value }
	}

	return message
}

function getTextFromInterleavedRawValue(rawValue: unknown, field: string) {
	if (!rawValue || typeof rawValue !== 'object') {
		return undefined
	}
	const choices = (rawValue as { choices?: unknown }).choices
	if (!Array.isArray(choices) || choices.length === 0) {
		return undefined
	}
	const choice = choices[0]
	if (!choice || typeof choice !== 'object') {
		return undefined
	}
	const delta = (choice as { delta?: unknown }).delta
	if (delta && typeof delta === 'object' && field in delta) {
		return (delta as Record<string, unknown>)[field]
	}
	const message = (choice as { message?: unknown }).message
	if (message && typeof message === 'object' && field in message) {
		return (message as Record<string, unknown>)[field]
	}
	return undefined
}

function mergeInterleavedValue(current: unknown, next: unknown): unknown {
	if (typeof next === 'undefined') {
		return current
	}
	if (typeof current === 'string' && typeof next === 'string') {
		return `${current}${next}`
	}
	return next
}

export function assertProviderUsable(provider: AIProviderConfig) {
	getProviderResolver(provider).assertUsable(provider)
}

export async function generateAssistantTurn(
	request: GenerateAssistantTurnRequest,
	callbacks?: GenerateAssistantTurnCallbacks,
): Promise<GenerateAssistantTurnResult> {
	const resolver = getProviderResolver(request.provider)
	const modelName =
		request.provider.models[request.model]?.name?.trim() || request.model
	const interleavedField = getInterleavedMessageField(
		request.provider,
		request.model,
	)
	const messages = mergeAdjacentUserMessages(request.messages)
	const { model, providerName } = resolver.createLanguageModel(
		request.provider as never,
		request.model,
		{ messages, interleavedField },
	)
	let interleavedValue: unknown
	let streamError: unknown
	const result = streamText({
		model,
		messages: toModelMessages(messages),
		tools: toAISDKTools(request.tools),
		stopWhen: stepCountIs(1),
		temperature: request.temperature,
		maxOutputTokens: request.maxTokens,
		onError: ({ error }) => {
			streamError = error
		},
		onChunk: async ({ chunk }) => {
			if (chunk.type === 'text-delta' && chunk.text) {
				await callbacks?.onTextDelta?.(chunk.text)
				return
			}
			if (chunk.type === 'raw' && interleavedField) {
				const nextValue = getTextFromInterleavedRawValue(
					chunk.rawValue,
					interleavedField,
				)
				interleavedValue = mergeInterleavedValue(interleavedValue, nextValue)
			}
		},
	})
	await result.consumeStream()
	if (streamError) {
		throw streamError
	}

	const text = await result.text
	const toolCalls = await result.toolCalls
	const usage = await result.totalUsage

	const message = toAssistantMessage(
		{
			text,
			toolCalls,
		},
		interleavedField
			? {
					field: interleavedField,
					value: interleavedValue,
				}
			: undefined,
	)

	return {
		message,
		meta: {
			providerId: request.provider.id,
			providerName: request.provider.name || providerName,
			modelName,
			usage: {
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				totalTokens: usage.totalTokens,
			},
		},
	}
}
