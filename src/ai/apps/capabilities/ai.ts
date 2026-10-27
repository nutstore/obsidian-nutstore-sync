import type {
	AppAIAPI,
	AppAIAgentSettings,
	AppAICall,
	AppAIEvent,
	AppAIResult,
	AppAIStreamPart,
	AppAIStreamResult,
} from '../ai/contract'
import type { JsonValue } from './kv'

/** Serialized into srcdoc: every runtime dependency must be inside this factory. */
export function createAppAI(
	rpc: (method: string, ...args: unknown[]) => Promise<unknown>,
): { api: AppAIAPI; receive(event: AppAIEvent): void; close(): void } {
	let nextRun = 0
	let closed = false
	const runs = new Map<
		number,
		{
			event(event: AppAIEvent): void
			cancel(): void
		}
	>()
	const error = (code: string) =>
		Object.assign(new Error(code), {
			name: code === 'CANCELLED' ? 'AbortError' : 'AppAIError',
			code,
		})
	const copy = <T>(value: T): T => {
		try {
			return JSON.parse(JSON.stringify(value)) as T
		} catch {
			throw error('INVALID_REQUEST')
		}
	}
	// The iframe has its own globals; it does not inherit host-installed polyfills.
	const mapValues = <T, U>(
		source: Record<string, T>,
		project: (value: T) => U,
	) => {
		const values: Record<string, U> = Object.create(null)
		for (const [key, value] of Object.entries(source))
			values[key] = project(value)
		return values
	}
	const start = (
		settings: AppAIAgentSettings,
		options: AppAICall,
		streaming: boolean,
	) => {
		if (closed || options.abortSignal?.aborted) throw error('CANCELLED')
		const id = ++nextRun
		const controller = new AbortController()
		const events: AppAIStreamPart[] = []
		const waiters = new Set<() => void>()
		let ended = false
		let failure: unknown
		const wake = () => {
			for (const resume of waiters) resume()
			waiters.clear()
		}
		let rejectCancellation!: (reason: Error) => void
		const cancellation = new Promise<never>((_resolve, reject) => {
			rejectCancellation = reject
		})
		const cancel = () => {
			if (ended) return
			const reason = error('CANCELLED')
			controller.abort(reason)
			rejectCancellation(reason)
			void rpc('ai.cancel', id).catch(() => {})
		}
		const tools = settings.tools ?? {}
		const descriptions = mapValues(tools, (definition) => ({
			description: definition.description,
			inputSchema: definition.inputSchema,
		}))
		// Only declared, JSON configuration crosses the boundary. Functions and signals stay local.
		const request = copy({
			runId: id,
			streaming,
			settings: { ...settings, tools: descriptions },
			call: { prompt: options.prompt, messages: options.messages },
		})
		const activeCalls = new Set<string>()
		runs.set(id, {
			cancel,
			event(event) {
				if (ended || controller.signal.aborted) return
				if ('chunk' in event) {
					events.push(event.chunk)
					wake()
					return
				}
				const { toolCallId, toolName, input } = event.toolCall
				if (activeCalls.has(toolCallId)) return
				activeCalls.add(toolCallId)
				const definition = Object.prototype.hasOwnProperty.call(tools, toolName)
					? tools[toolName]
					: undefined
				void Promise.resolve()
					.then(() => {
						if (controller.signal.aborted) throw error('CANCELLED')
						if (!definition) throw error('INVALID_REQUEST')
						return definition.execute(input, {
							toolCallId,
							abortSignal: controller.signal,
						})
					})
					.then(
						(output) => {
							if (!ended && !controller.signal.aborted)
								return rpc('ai.toolResult', id, toolCallId, { output })
						},
						() => {
							if (!ended && !controller.signal.aborted)
								return rpc('ai.toolResult', id, toolCallId, {
									error: 'App tool execution failed',
								})
						},
					)
					.catch(() => {
						// A non-cloneable tool result must settle the host call rather than leave it waiting.
						if (!ended && !controller.signal.aborted)
							void rpc('ai.toolResult', id, toolCallId, {
								error: 'App tool result is not transferable',
							}).catch(() => {})
					})
			},
		})
		options.abortSignal?.addEventListener('abort', cancel, { once: true })
		const result = Promise.race([
			rpc('ai.run', request) as Promise<AppAIResult>,
			cancellation,
		])
			.catch((reason: unknown) => {
				failure = reason
				throw reason
			})
			.finally(() => {
				ended = true
				controller.abort(error('CANCELLED'))
				options.abortSignal?.removeEventListener('abort', cancel)
				runs.delete(id)
				wake()
			})
		// Streaming clients can observe a stream before accessing any final-result promise.
		void result.catch(() => {})
		async function* parts(): AsyncGenerator<AppAIStreamPart> {
			let index = 0
			while (true) {
				while (index < events.length) yield events[index++]
				if (ended) {
					if (failure)
						throw failure instanceof Error ? failure : error('AI_FAILED')
					return
				}
				await new Promise<void>((resolve) => {
					waiters.add(resolve)
				})
			}
		}
		// Streams and final properties share one run. Reading both streams never repeats inference.
		const final = <K extends keyof AppAIResult>(
			key: K,
		): Promise<AppAIResult[K]> => {
			const promise = result.then((value) => value[key])
			void promise.catch(() => {})
			return promise
		}
		const stream: AppAIStreamResult = {
			stream: { [Symbol.asyncIterator]: parts },
			textStream: {
				async *[Symbol.asyncIterator]() {
					for await (const part of parts())
						if (part.type === 'text-delta') yield part.text
				},
			},
			get text() {
				return final('text')
			},
			get output() {
				return final('output')
			},
			get responseMessages() {
				return final('responseMessages')
			},
			get finishReason() {
				return final('finishReason')
			},
			get usage() {
				return final('usage')
			},
		}
		return { result, stream }
	}
	return {
		api: Object.freeze({
			createAgent(settings: AppAIAgentSettings = {}) {
				// Snapshot configuration while retaining local tool callbacks.
				const tools = mapValues(settings.tools ?? {}, (definition) => ({
					...copy({
						description: definition.description,
						inputSchema: definition.inputSchema,
					}),
					execute: definition.execute,
				}))
				const config = { ...copy({ ...settings, tools: undefined }), tools }
				return Object.freeze({
					async generate(options: AppAICall) {
						return start(config, options, false).result
					},
					async stream(options: AppAICall) {
						return start(config, options, true).stream
					},
				})
			},
			Output: Object.freeze({
				object: ({ schema }: { schema: Record<string, JsonValue> }) => ({
					type: 'object' as const,
					schema,
				}),
			}),
			isStepCount: (count: number) => ({ type: 'step-count' as const, count }),
		}),
		receive(event) {
			runs.get(event.runId)?.event(event)
		},
		close() {
			closed = true
			for (const run of runs.values()) run.cancel()
		},
	}
}
