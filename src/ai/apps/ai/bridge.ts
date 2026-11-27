import { raceWithAbort } from '~/utils/abortable'
import { isAbortError } from '~/utils/abort'
import {
	APP_AI_LIMITS,
	AppAIError,
	appAIRequestSchema,
	boundedAIJSON,
	type AppAIDiagnosticDetail,
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
		private readonly onDiagnostic?: (detail: AppAIDiagnosticDetail) => void,
	) {}
	private report(detail: AppAIDiagnosticDetail, runId?: number) {
		this.onDiagnostic?.(
			runId !== undefined && detail.runId === undefined
				? { ...detail, runId }
				: detail,
		)
	}
	async dispatch(method: string, args: unknown[]): Promise<unknown> {
		if (this.closed) throw new AppAIError('CANCELLED')
		if (method === 'run') {
			const rawRunId =
				args[0] &&
				typeof args[0] === 'object' &&
				typeof (args[0] as { runId?: unknown }).runId === 'number'
					? (args[0] as { runId: number }).runId
					: undefined
			if (args.length !== 1) {
				this.report(
					{
						code: 'INVALID_REQUEST',
						reason: 'ai.run requires exactly 1 request argument',
					},
					rawRunId,
				)
				throw new AppAIError('INVALID_REQUEST')
			}
			const input = boundedAIJSON(args[0], APP_AI_LIMITS.requestBytes)
			const parsed = appAIRequestSchema.safeParse(input)
			if (!parsed.success) {
				const summary = parsed.error.issues
					.slice(0, 3)
					.map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`)
					.join('; ')
				this.report(
					{
						code: 'INVALID_REQUEST',
						reason: `Invalid AI request: ${summary}`,
					},
					rawRunId,
				)
				throw new AppAIError('INVALID_REQUEST')
			}
			const request = parsed.data
			if (request.runId <= this.lastRun) {
				this.report(
					{
						code: 'INVALID_REQUEST',
						reason: 'Non-monotonic AI runId',
					},
					request.runId,
				)
				throw new AppAIError('INVALID_REQUEST')
			}
			this.lastRun = request.runId
			if (!this.host) {
				this.report(
					{
						code: 'AI_UNAVAILABLE_IN_VALIDATION',
						reason: 'app.ai is disabled during hidden startup validation',
					},
					request.runId,
				)
				throw new AppAIError('AI_UNAVAILABLE_IN_VALIDATION')
			}
			if (this.runs.size >= APP_AI_LIMITS.concurrent) {
				this.report(
					{
						code: 'LIMIT_EXCEEDED',
						reason: `Per-App concurrent AI limit reached (${APP_AI_LIMITS.concurrent})`,
					},
					request.runId,
				)
				throw new AppAIError('LIMIT_EXCEEDED')
			}
			const run: ActiveRun = {
				controller: new AbortController(),
				tools: new Map(),
				seen: new Set(),
			}
			this.runs.set(request.runId, run)
			const timer = this.win.setTimeout(() => {
				this.report(
					{
						code: 'LIMIT_EXCEEDED',
						reason: `AI run timed out after ${APP_AI_LIMITS.timeoutMs}ms`,
					},
					request.runId,
				)
				run.controller.abort(new AppAIError('LIMIT_EXCEEDED'))
			}, APP_AI_LIMITS.timeoutMs)
			try {
				return await raceWithAbort(
					this.host(request, {
						signal: run.controller.signal,
						diagnose: (detail) => this.report(detail, request.runId),
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
							) {
								this.report(
									{
										code: 'INVALID_REQUEST',
										reason: `Rejected tool invocation for "${toolName}"`,
										toolName,
									},
									request.runId,
								)
								throw new AppAIError('INVALID_REQUEST')
							}
							run.seen.add(toolCallId)
							const pending = new Promise<JsonValue>((resolve, reject) => {
								run.tools.set(toolCallId, { resolve, reject })
							})
							const timeout = this.win.setTimeout(() => {
								this.report(
									{
										code: 'LIMIT_EXCEEDED',
										reason: `App tool "${toolName}" timed out after ${APP_AI_LIMITS.toolTimeoutMs}ms`,
										toolName,
									},
									request.runId,
								)
								run.controller.abort(new AppAIError('LIMIT_EXCEEDED'))
							}, APP_AI_LIMITS.toolTimeoutMs)
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
