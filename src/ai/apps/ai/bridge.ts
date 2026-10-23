import { raceWithAbort } from '~/utils/abortable'
import { isAbortError } from '~/utils/abort'
import {
	APP_AI_LIMITS,
	AppAIError,
	appAIRequestSchema,
	boundedAIJSON,
	type AppAIEvent,
	type AppAIHost,
} from './contract'
import type { JsonValue } from '../capabilities/kv'

interface PendingTool {
	resolve(value: JsonValue): void
	reject(error: Error): void
}
interface ActiveRun {
	controller: AbortController
	tools: Map<string, PendingTool>
	seen: Set<string>
}

/** One bridge is owned by one iframe; every pending inference/tool is revoked on teardown. */
export class AppAIBridge {
	private readonly runs = new Map<number, ActiveRun>()
	private lastRun = 0
	private closed = false
	constructor(
		private readonly host: AppAIHost | undefined,
		private readonly post: (event: AppAIEvent) => void,
		private readonly win: Window = window,
	) {}
	async dispatch(method: string, args: unknown[]): Promise<unknown> {
		if (this.closed) throw new AppAIError('CANCELLED')
		if (method === 'run') {
			if (args.length !== 1) throw new AppAIError('INVALID_REQUEST')
			const input = boundedAIJSON(args[0], APP_AI_LIMITS.requestBytes)
			const parsed = appAIRequestSchema.safeParse(input)
			if (!parsed.success) throw new AppAIError('INVALID_REQUEST')
			const request = parsed.data
			if (request.runId <= this.lastRun) throw new AppAIError('INVALID_REQUEST')
			this.lastRun = request.runId
			if (!this.host) throw new AppAIError('AI_UNAVAILABLE_IN_VALIDATION')
			if (this.runs.size >= APP_AI_LIMITS.concurrent)
				throw new AppAIError('LIMIT_EXCEEDED')
			const run: ActiveRun = {
				controller: new AbortController(),
				tools: new Map(),
				seen: new Set(),
			}
			this.runs.set(request.runId, run)
			const timer = this.win.setTimeout(
				() => run.controller.abort(new AppAIError('LIMIT_EXCEEDED')),
				APP_AI_LIMITS.timeoutMs,
			)
			try {
				return await raceWithAbort(
					this.host(request, {
						signal: run.controller.signal,
						emit: (chunk) => {
							run.controller.signal.throwIfAborted()
							this.post({ event: 'ai', runId: request.runId, chunk })
						},
						execute: async (toolName, input, toolCallId) => {
							run.controller.signal.throwIfAborted()
							if (
								!Object.hasOwn(request.settings.tools ?? {}, toolName) ||
								run.seen.has(toolCallId) ||
								run.tools.size >= 64
							)
								throw new AppAIError('INVALID_REQUEST')
							run.seen.add(toolCallId)
							const pending = new Promise<JsonValue>((resolve, reject) => {
								run.tools.set(toolCallId, { resolve, reject })
							})
							const timeout = this.win.setTimeout(
								() => run.controller.abort(new AppAIError('LIMIT_EXCEEDED')),
								APP_AI_LIMITS.toolTimeoutMs,
							)
							try {
								this.post({
									event: 'ai',
									runId: request.runId,
									toolCall: {
										toolName,
										toolCallId,
										input: boundedAIJSON(input, APP_AI_LIMITS.toolBytes),
									},
								})
								return await raceWithAbort(pending, run.controller.signal)
							} finally {
								this.win.clearTimeout(timeout)
								run.tools.delete(toolCallId)
							}
						},
					}),
					run.controller.signal,
				)
			} catch (error) {
				if (error instanceof AppAIError) throw error
				throw new AppAIError(isAbortError(error) ? 'CANCELLED' : 'AI_FAILED')
			} finally {
				this.win.clearTimeout(timer)
				run.controller.abort(new AppAIError('CANCELLED'))
				this.runs.delete(request.runId)
			}
		}
		const runId = args[0]
		if (typeof runId !== 'number') throw new AppAIError('INVALID_REQUEST')
		const run = this.runs.get(runId)
		if (method === 'cancel' && args.length === 1) {
			run?.controller.abort(new AppAIError('CANCELLED'))
			return null
		}
		if (method === 'toolResult' && args.length === 3) {
			const callId = args[1]
			const pending =
				typeof callId === 'string' ? run?.tools.get(callId) : undefined
			if (!pending) throw new AppAIError('INVALID_REQUEST')
			run!.tools.delete(callId as string)
			try {
				const result = boundedAIJSON(args[2], APP_AI_LIMITS.toolBytes)
				if (!result || typeof result !== 'object' || Array.isArray(result))
					throw new AppAIError('INVALID_REQUEST')
				if (Object.hasOwn(result, 'output')) pending.resolve(result.output)
				else pending.reject(new Error('App tool execution failed'))
			} catch {
				pending.reject(new Error('Invalid App tool result'))
			}
			return null
		}
		throw new AppAIError('INVALID_REQUEST')
	}
	close() {
		this.closed = true
		for (const run of this.runs.values())
			run.controller.abort(new AppAIError('CANCELLED'))
	}
}
