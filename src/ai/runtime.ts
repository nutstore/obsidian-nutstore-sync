import type { AssistantModelMessage } from 'ai'
import { tool as aiTool, stepCountIs, streamText } from 'ai'
import { getProviderResolver } from './providers/registry'
import {
	AIMessage,
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
	const resolver = getProviderResolver(request.provider)
	const modelName =
		request.provider.models[request.model]?.name?.trim() || request.model
	const messages = mergeAdjacentUserMessages(request.messages)
	const { model, providerName } = resolver.createLanguageModel(
		request.provider,
		request.model,
	)
	let streamError: unknown
	const result = streamText({
		model,
		messages: messages,
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
