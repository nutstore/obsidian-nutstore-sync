import {
	Output,
	ToolLoopAgent,
	isStepCount,
	jsonSchema,
	tool,
	type TextStreamPart,
	type ToolSet,
} from 'ai'
import { Validator } from '@cfworker/json-schema'
import type { NutstoreSettings } from '~/settings'
import type { ModuleScope } from '~/modules/lifecycle'
import { getModelById, getProviderById } from '~/ai/catalog/config'
import { assertProviderUsable, resolveLanguageModel } from '~/ai/core/runtime'
import { resolveModelOutputLimit } from '~/ai/core/inference'
import { raceWithAbort } from '~/utils/abortable'
import {
	APP_AI_LIMITS,
	AppAIError,
	appAIMessageSchema,
	boundedAIJSON,
	type AppAIHost,
	type AppAIResult,
	type AppAIStreamPart,
	type AppAIUsage,
} from './contract'
import { jsonBytes, type JsonValue } from '../capabilities/kv'

/** Remove optional undefined fields; never use this for untrusted tool outputs. */
function wireJSON(value: unknown) {
	return JSON.parse(JSON.stringify(value)) as JsonValue
}
function usage(value: AppAIUsage): AppAIUsage {
	return {
		inputTokens: value.inputTokens,
		outputTokens: value.outputTokens,
		totalTokens: value.totalTokens,
		inputTokenDetails: value.inputTokenDetails,
		outputTokenDetails: value.outputTokenDetails,
	}
}

/** Project the supported SDK stream subset. Provider metadata/headers/errors are host-private. */
function streamPart(
	part: TextStreamPart<ToolSet>,
): AppAIStreamPart | undefined {
	switch (part.type) {
		case 'start':
		case 'start-step':
			return { type: part.type }
		case 'text-start':
		case 'text-end':
		case 'reasoning-start':
		case 'reasoning-end':
		case 'tool-input-end':
			return { type: part.type, id: part.id }
		case 'text-delta':
		case 'reasoning-delta':
			return { type: part.type, id: part.id, text: part.text }
		case 'tool-input-start':
			return { type: part.type, id: part.id, toolName: part.toolName }
		case 'tool-input-delta':
			return { type: part.type, id: part.id, delta: part.delta }
		case 'tool-call':
			return {
				type: part.type,
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				input: boundedAIJSON(part.input, APP_AI_LIMITS.toolBytes),
			}
		case 'tool-result':
			return {
				type: part.type,
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				input: boundedAIJSON(part.input, APP_AI_LIMITS.toolBytes),
				output: boundedAIJSON(part.output, APP_AI_LIMITS.toolBytes),
			}
		case 'tool-error':
			return {
				type: part.type,
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				input: boundedAIJSON(part.input, APP_AI_LIMITS.toolBytes),
				error: 'App tool execution failed',
			}
		case 'finish-step':
			return {
				type: part.type,
				finishReason: part.finishReason,
				usage: usage(part.usage),
			}
		case 'finish':
			return {
				type: part.type,
				finishReason: part.finishReason,
				totalUsage: usage(part.totalUsage),
			}
		case 'error':
			throw part.error
		case 'abort':
			throw new AppAIError('CANCELLED')
		// Files, sources and provider-defined content need an explicit future transport contract.
		default:
			return undefined
	}
}

/**
 * AI SDK owns inference, schema validation and tool looping. This adapter owns
 * model selection and host policy; it has no chat/session or App business state.
 */
export function createAppAIHost(
	getSettings: () => Pick<NutstoreSettings['ai'], 'providers' | 'defaultModel'>,
	scope: ModuleScope,
): AppAIHost {
	let active = 0
	return async (request, execution) => {
		scope.check()
		if (active >= APP_AI_LIMITS.globalConcurrent)
			throw new AppAIError('LIMIT_EXCEEDED')
		active++
		const controller = new AbortController()
		const cancel = () => controller.abort(new AppAIError('CANCELLED'))
		const release = scope.register(cancel)
		execution.signal.addEventListener('abort', cancel, { once: true })
		if (execution.signal.aborted) cancel()
		try {
			const settings = getSettings()
			const selection = request.settings.model ?? settings.defaultModel
			const provider = getProviderById(
				settings.providers,
				selection?.providerId,
			)
			const model = getModelById(provider, selection?.modelId)
			if (!provider || !model) throw new AppAIError('MODEL_UNAVAILABLE')
			try {
				assertProviderUsable(provider)
			} catch {
				throw new AppAIError('MODEL_UNAVAILABLE')
			}
			const definitions = Object.entries(request.settings.tools ?? {})
			if (definitions.length > 64) throw new AppAIError('LIMIT_EXCEEDED')
			if (
				!model.modalities.input.includes('text') ||
				!model.modalities.output.includes('text') ||
				(definitions.length && !model.tool_call) ||
				(request.settings.output && model.structured_output === false)
			)
				throw new AppAIError('UNSUPPORTED_CAPABILITY')
			const compile = (schema: Record<string, unknown>) => {
				// Validation is mandatory: raw jsonSchema() alone does not validate tool/model output.
				try {
					if (schema.type !== 'object') throw new AppAIError('INVALID_REQUEST')
					const validator = new Validator(schema, '2020-12')
					return jsonSchema<JsonValue>(schema, {
						validate: async (value) => {
							const result = validator.validate(value)
							return result.valid
								? {
										success: true,
										value: boundedAIJSON(value, APP_AI_LIMITS.toolBytes),
									}
								: {
										success: false,
										error: new Error('Schema validation failed'),
									}
						},
					})
				} catch {
					throw new AppAIError('INVALID_REQUEST')
				}
			}
			const tools: ToolSet = Object.fromEntries(
				definitions.map(([name, definition]) => {
					if (
						!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(name) ||
						['__proto__', 'constructor', 'prototype'].includes(name)
					)
						throw new AppAIError('INVALID_REQUEST')
					return [
						name,
						tool({
							description: definition.description,
							inputSchema: compile(definition.inputSchema),
							execute: (input, context) => {
								controller.signal.throwIfAborted()
								return execution.execute(name, input, context.toolCallId)
							},
						}),
					]
				}),
			)
			const output = request.settings.output
				? Output.object({ schema: compile(request.settings.output.schema) })
				: undefined
			const agent = new ToolLoopAgent({
				model: resolveLanguageModel(provider, model.id).model,
				instructions: request.settings.instructions,
				tools,
				output,
				stopWhen: isStepCount(
					request.settings.stopWhen?.count ?? APP_AI_LIMITS.steps,
				),
				maxOutputTokens: Math.min(
					request.settings.maxOutputTokens ?? APP_AI_LIMITS.outputTokens,
					resolveModelOutputLimit(model) ?? APP_AI_LIMITS.outputTokens,
				),
				maxRetries: 0,
				// Even if a future message subset accepts attachments, model-side URL fetches remain denied.
				experimental_download: async (assets) => {
					if (assets.length) throw new AppAIError('UNSUPPORTED_CAPABILITY')
					return []
				},
			})
			const run = async (): Promise<AppAIResult> => {
				const result = await agent.stream({
					...request.call,
					abortSignal: controller.signal,
				})
				let bytes = 0
				for await (const part of result.stream) {
					controller.signal.throwIfAborted()
					const chunk = streamPart(part)
					if (!chunk) continue
					bytes += jsonBytes(wireJSON(chunk))
					if (bytes > APP_AI_LIMITS.responseBytes)
						throw new AppAIError('LIMIT_EXCEEDED')
					if (request.streaming) execution.emit(chunk)
				}
				const messages = await result.responseMessages
				// Preserve SDK continuation metadata, while excluding HTTP responses and host configuration.
				const responseMessages = messages.map((message) => {
					const parsed = appAIMessageSchema.parse(wireJSON(message))
					if (parsed.role === 'user') throw new AppAIError('AI_FAILED')
					return parsed
				})
				let structured: JsonValue | undefined
				if (output) {
					try {
						structured = await result.output
					} catch {
						throw new AppAIError('INVALID_OUTPUT')
					}
				}
				const value: AppAIResult = {
					text: await result.text,
					...(output ? { output: structured } : {}),
					responseMessages,
					finishReason: await result.finishReason,
					usage: usage(await result.usage),
				}
				boundedAIJSON(wireJSON(value), APP_AI_LIMITS.responseBytes)
				return value
			}
			return await raceWithAbort(run(), controller.signal)
		} catch (error) {
			if (controller.signal.aborted) throw new AppAIError('CANCELLED')
			if (error instanceof AppAIError) throw error
			// Provider errors can contain request bodies, keys and endpoints. Keep them inside the host.
			throw new AppAIError('AI_FAILED')
		} finally {
			controller.abort(new AppAIError('CANCELLED'))
			release()
			execution.signal.removeEventListener('abort', cancel)
			active--
		}
	}
}
