import type {
	FinishReason,
	LanguageModelUsage,
	ModelMessage,
	TextStreamPart,
	ToolSet,
} from 'ai'
import { z } from 'zod/mini'
import { jsonBytes, jsonValue, type JsonValue } from '../capabilities/kv'

/** The bridge carries JSON, never provider objects, credentials or executable schemas. */
export type AppAIModel = { providerId: string; modelId: string }
export type AppAIOutput = { type: 'object'; schema: Record<string, JsonValue> }
export type AppAIStopCondition = { type: 'step-count'; count: number }
export type AppAIUsage = Omit<LanguageModelUsage, 'raw'>

// SDK response messages can carry reasoning signatures and continuation IDs.
// Keep that JSON verbatim for replay; this is not the host's provider configuration.
const providerOptions = z.optional(
	z.record(z.string(), z.record(z.string(), z.json())),
)
const textPart = z.object({
	type: z.literal('text'),
	text: z.string(),
	providerOptions,
})
const reasoningPart = z.object({
	type: z.literal('reasoning'),
	text: z.string(),
	providerOptions,
})
const toolCall = z.object({
	type: z.literal('tool-call'),
	toolCallId: z.string(),
	toolName: z.string(),
	input: z.unknown(),
	providerOptions,
})
const toolOutput = z.union([
	z.object({ type: z.literal('text'), value: z.string() }),
	z.object({ type: z.literal('json'), value: z.json() }),
	z.object({ type: z.literal('error-text'), value: z.string() }),
	z.object({ type: z.literal('error-json'), value: z.json() }),
])
const toolResult = z.object({
	type: z.literal('tool-result'),
	toolCallId: z.string(),
	toolName: z.string(),
	output: toolOutput,
	providerOptions,
})
/** Text and JSON tool history are the supported ModelMessage subset. No URL downloads. */
export const appAIMessageSchema = z.union([
	z.object({
		role: z.literal('user'),
		content: z.union([z.string(), z.array(textPart)]),
	}),
	z.object({
		role: z.literal('assistant'),
		content: z.union([
			z.string(),
			z.array(z.union([textPart, reasoningPart, toolCall])),
		]),
	}),
	z.object({ role: z.literal('tool'), content: z.array(toolResult) }),
])
export type AppAIMessage = z.infer<typeof appAIMessageSchema>
// A compile-time check keeps the transport subset aligned with the installed SDK.
type SDKMessage<T extends ModelMessage> = T
export type AppAIResponseMessage = Extract<
	SDKMessage<AppAIMessage>,
	{ role: 'assistant' | 'tool' }
>

export interface AppAITool {
	description: string
	inputSchema: Record<string, JsonValue>
	execute: (
		input: JsonValue,
		context: { toolCallId: string; abortSignal: AbortSignal },
	) => JsonValue | Promise<JsonValue>
}
export interface AppAIAgentSettings {
	model?: AppAIModel
	instructions?: string
	tools?: Record<string, AppAITool>
	output?: AppAIOutput
	stopWhen?: AppAIStopCondition
	maxOutputTokens?: number
}
export type AppAICall = (
	| { prompt: string; messages?: never }
	| { messages: AppAIMessage[]; prompt?: never }
) & { abortSignal?: AbortSignal }
export interface AppAIResult {
	text: string
	output?: JsonValue
	responseMessages: AppAIResponseMessage[]
	finishReason: FinishReason
	usage: AppAIUsage
}
type SDKPart = TextStreamPart<ToolSet>
type SimplePart = Extract<
	SDKPart,
	{
		type:
			| 'start'
			| 'text-start'
			| 'text-delta'
			| 'text-end'
			| 'reasoning-start'
			| 'reasoning-delta'
			| 'reasoning-end'
			| 'tool-input-start'
			| 'tool-input-delta'
			| 'tool-input-end'
	}
>
type PublicPart<T> = T extends unknown
	? Omit<T, 'providerMetadata' | 'toolMetadata'>
	: never
/** SDK event names and identities are preserved; raw provider metadata never crosses the bridge. */
export type AppAIStreamPart =
	| PublicPart<SimplePart>
	| { type: 'start-step' }
	| { type: 'finish-step'; finishReason: FinishReason; usage: AppAIUsage }
	| { type: 'finish'; finishReason: FinishReason; totalUsage: AppAIUsage }
	| {
			type: 'tool-call'
			toolCallId: string
			toolName: string
			input: JsonValue
	  }
	| {
			type: 'tool-result'
			toolCallId: string
			toolName: string
			input: JsonValue
			output: JsonValue
	  }
	| {
			type: 'tool-error'
			toolCallId: string
			toolName: string
			input: JsonValue
			error: string
	  }
export interface AppAIStreamResult {
	stream: AsyncIterable<AppAIStreamPart>
	textStream: AsyncIterable<string>
	text: Promise<string>
	output: Promise<JsonValue | undefined>
	responseMessages: Promise<AppAIResponseMessage[]>
	finishReason: Promise<FinishReason>
	usage: Promise<AppAIUsage>
}
export interface AppAIAgent {
	generate(options: AppAICall): Promise<AppAIResult>
	stream(options: AppAICall): Promise<AppAIStreamResult>
}
export interface AppAIAPI {
	createAgent(settings?: AppAIAgentSettings): AppAIAgent
	Output: {
		object(options: { schema: Record<string, JsonValue> }): AppAIOutput
	}
	isStepCount(count: number): AppAIStopCondition
}

export const APP_AI_LIMITS = {
	concurrent: 4,
	globalConcurrent: 8,
	steps: 20,
	outputTokens: 16_384,
	requestBytes: 1_048_576,
	responseBytes: 2_097_152,
	toolBytes: 262_144,
	timeoutMs: 180_000,
	toolTimeoutMs: 30_000,
} as const

export const appAIRequestSchema = z.strictObject({
	runId: z.number().check(z.int(), z.minimum(1)),
	streaming: z.boolean(),
	settings: z.strictObject({
		model: z.optional(
			z.strictObject({ providerId: z.string(), modelId: z.string() }),
		),
		instructions: z.optional(z.string()),
		tools: z.optional(
			z.record(
				z.string(),
				z.strictObject({
					description: z.string(),
					inputSchema: z.record(z.string(), z.unknown()),
				}),
			),
		),
		output: z.optional(
			z.strictObject({
				type: z.literal('object'),
				schema: z.record(z.string(), z.unknown()),
			}),
		),
		stopWhen: z.optional(
			z.strictObject({
				type: z.literal('step-count'),
				count: z
					.number()
					.check(z.int(), z.minimum(1), z.maximum(APP_AI_LIMITS.steps)),
			}),
		),
		maxOutputTokens: z.optional(
			z
				.number()
				.check(z.int(), z.minimum(1), z.maximum(APP_AI_LIMITS.outputTokens)),
		),
	}),
	call: z.union([
		z.strictObject({ prompt: z.string().check(z.minLength(1)) }),
		z.strictObject({
			messages: z
				.array(appAIMessageSchema)
				.check(z.minLength(1), z.maxLength(1000)),
		}),
	]),
})
export type AppAIRequest = z.infer<typeof appAIRequestSchema>
export type AppAIErrorCode =
	| 'INVALID_REQUEST'
	| 'MODEL_UNAVAILABLE'
	| 'UNSUPPORTED_CAPABILITY'
	| 'INVALID_OUTPUT'
	| 'LIMIT_EXCEEDED'
	| 'CANCELLED'
	| 'AI_UNAVAILABLE_IN_VALIDATION'
	| 'AI_FAILED'
export class AppAIError extends Error {
	constructor(readonly code: AppAIErrorCode) {
		super(code)
		this.name = code === 'CANCELLED' ? 'AbortError' : 'AppAIError'
	}
}
export function boundedAIJSON(value: unknown, maximum: number): JsonValue {
	try {
		const json = jsonValue(value)
		if (jsonBytes(json) > maximum) throw new AppAIError('LIMIT_EXCEEDED')
		return json
	} catch (error) {
		if (error instanceof AppAIError) throw error
		throw new AppAIError('INVALID_REQUEST')
	}
}
export type AppAIEvent = {
	event: 'ai'
	runId: number
} & (
	| { chunk: AppAIStreamPart }
	| { toolCall: { toolCallId: string; toolName: string; input: JsonValue } }
)
export interface AppAIExecution {
	signal: AbortSignal
	emit(chunk: AppAIStreamPart): void
	execute(
		toolName: string,
		input: JsonValue,
		toolCallId: string,
	): Promise<JsonValue>
}
export type AppAIHost = (
	request: AppAIRequest,
	execution: AppAIExecution,
) => Promise<AppAIResult>
