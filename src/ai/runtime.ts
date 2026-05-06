import type { GenerateTextResult, ModelMessage } from 'ai'
import { tool as aiTool, generateText, stepCountIs } from 'ai'
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

function toTextParts(text?: string | null): AIMessageContentPart[] | null {
	if (!text) {
		return null
	}
	return [{ type: 'text', text }]
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
	result: GenerateTextResult<any, any>,
	interleavedField?: string,
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

	if (interleavedField && message.role === 'assistant') {
		const body = result.response.body as any
		const raw = body?.choices?.[0]?.message?.[interleavedField]
		if (raw !== undefined) {
			message.interleaved = { [interleavedField]: raw }
		}
	}

	return message
}

export function assertProviderUsable(provider: AIProviderConfig) {
	getProviderResolver(provider).assertUsable(provider)
}

export async function generateAssistantTurn(
	request: GenerateAssistantTurnRequest,
): Promise<GenerateAssistantTurnResult> {
	const resolver = getProviderResolver(request.provider)
	const modelName =
		request.provider.models[request.model]?.name?.trim() || request.model
	const interleavedField = getInterleavedMessageField(
		request.provider,
		request.model,
	)
	const { model, providerName } = resolver.createLanguageModel(
		request.provider as never,
		request.model,
		{ messages: request.messages, interleavedField },
	)
	const result = await generateText({
		model,
		messages: toModelMessages(request.messages),
		tools: toAISDKTools(request.tools),
		stopWhen: stepCountIs(1),
		temperature: request.temperature,
		maxOutputTokens: request.maxTokens,
		experimental_include: {
			responseBody: !!interleavedField,
		},
	})

	return {
		message: toAssistantMessage(result, interleavedField),
		meta: {
			providerId: request.provider.id,
			providerName: request.provider.name || providerName,
			modelName,
			usage: {
				inputTokens: result.usage.inputTokens,
				outputTokens: result.usage.outputTokens,
				totalTokens: result.usage.totalTokens,
			},
		},
	}
}
