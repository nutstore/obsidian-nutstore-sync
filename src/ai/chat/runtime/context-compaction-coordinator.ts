import type { ModelMessage, ToolSet } from 'ai'
import type { ChatSession } from '~/ai/chat/domain'
import type { MessageFactory } from '~/ai/chat/messages/message-factory'
import {
	commitContextCompression,
	createContextCompressionPlan,
	estimateContextTokens,
	generateContextCompression,
	shouldAutoCompressAgent,
	shouldStartContextCompaction,
	type ContextCompressionPlan,
} from '~/ai/chat/runtime/context-compression'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
import type { AIModelConfig, AIProviderConfig } from '~/ai/core/types'
import { createAbortError } from '~/ai/transport/abort'

export { createContextCompactionRevision } from '~/ai/chat/runtime/context-compaction-revision'

export interface ContextCompactionRequest {
	session: ChatSession
	agent: ChatAgentState
	provider: AIProviderConfig
	model: AIModelConfig
	ensureProviderReady?: () => Promise<void>
	resolveSummaryContext: () => Promise<{
		system?: string
		tools?: ToolSet
	}>
	buildMessages?: (
		messages: AppUIMessage[],
		tools: ToolSet,
	) => Promise<ModelMessage[]>
	isCancelled: () => boolean
	/** Immutable identity of the model, prompt, and tool configuration. */
	revision: string
	/** Reject a result when the model, system prompt, or session has changed. */
	isCurrent?: () => boolean
}

type GeneratedCompaction =
	| { status: 'ready'; plan: ContextCompressionPlan; summary: string }
	| { status: 'unavailable' | 'failed' | 'stale' | 'cancelled' }

type ContextCompactionJob = {
	sessionId: string
	agentId: string
	revision: string
	allowFullContext: boolean
	controller: AbortController
	completion: Promise<GeneratedCompaction>
	result?: GeneratedCompaction
}

export type ContextCompactionDecision = 'ready' | 'compact'

export interface ContextCompactionProgress {
	beforeTokens: number
	afterTokens: number
	revision: string
}

export class ContextCompactionError extends Error {
	constructor(readonly reason: 'unavailable' | 'failed' | 'stale') {
		super(`Context compaction ${reason}`)
		this.name = 'ContextCompactionError'
	}
}

/**
 * Owns one optimistic, snapshot-based compaction job for each agent. It
 * provides atomic context operations; AgentLoop alone owns control flow.
 */
export class ContextCompactionCoordinator {
	private jobs = new Map<string, ContextCompactionJob>()

	constructor(
		private store: SessionStore,
		private messageFactory: MessageFactory,
	) {}

	/** Start optimistic work when useful and decide whether the loop must wait. */
	inspect(request: ContextCompactionRequest): ContextCompactionDecision {
		if (request.isCancelled()) return 'ready'
		let job = this.currentJob(request)
		if (!job && shouldStartContextCompaction(request.agent, request.model)) {
			job = this.start(request, false)
		}
		if (
			job?.result?.status === 'stale' ||
			job?.result?.status === 'cancelled'
		) {
			this.deleteIfCurrent(request, job)
			job = undefined
		}
		return job?.result?.status === 'ready' ||
			job?.result?.status === 'failed' ||
			shouldAutoCompressAgent(request.agent, request.model)
			? 'compact'
			: 'ready'
	}

	/** Perform one atomic compaction, reusing optimistic work when possible. */
	async compact(
		request: ContextCompactionRequest,
	): Promise<ContextCompactionProgress> {
		this.throwIfCancelled(request)
		let job = this.currentJob(request) ?? this.start(request, false)
		let usedFullContext = job?.allowFullContext ?? false

		while (job) {
			const generated = await job.completion
			this.deleteIfCurrent(request, job)
			this.throwIfCancelled(request)

			if (generated.status === 'ready' && this.isCurrent(request)) {
				const beforeTokens = estimateContextTokens(request.agent)
				const committed = await commitContextCompression({
					session: request.session,
					agent: request.agent,
					plan: generated.plan,
					summary: generated.summary,
					store: this.store,
					messageFactory: this.messageFactory,
				})
				this.throwIfCancelled(request)
				if (committed) {
					return {
						beforeTokens,
						afterTokens: estimateContextTokens(request.agent),
						revision: `${job.revision}:${generated.plan.summarizedThroughMessageId}`,
					}
				}
			}

			if (generated.status === 'failed') {
				throw new ContextCompactionError('failed')
			}
			if (!this.isCurrent(request)) {
				throw new ContextCompactionError('stale')
			}
			if (usedFullContext) {
				throw new ContextCompactionError(
					generated.status === 'unavailable' ? 'unavailable' : 'stale',
				)
			}

			usedFullContext = true
			job = this.start(request, true)
		}

		this.throwIfCancelled(request)
		throw new ContextCompactionError('unavailable')
	}

	shouldSuspendAtSafePoint(request: ContextCompactionRequest) {
		return request.isCancelled() || this.inspect(request) === 'compact'
	}

	cancel(sessionId: string, agentId?: string) {
		for (const [key, job] of this.jobs) {
			if (job.sessionId !== sessionId) continue
			if (agentId && job.agentId !== agentId) continue
			job.controller.abort()
			this.jobs.delete(key)
		}
	}

	private currentJob(request: ContextCompactionRequest) {
		const key = this.keyFor(request)
		const job = this.jobs.get(key)
		if (!job || job.revision === request.revision) return job
		job.controller.abort()
		this.jobs.delete(key)
		return undefined
	}

	private start(request: ContextCompactionRequest, allowFullContext: boolean) {
		if (request.isCancelled()) return undefined
		const controller = new AbortController()
		const job: ContextCompactionJob = {
			sessionId: request.session.id,
			agentId: request.agent.id,
			revision: request.revision,
			allowFullContext,
			controller,
			completion: Promise.resolve({ status: 'unavailable' }),
		}
		job.completion = this.generate(request, controller, allowFullContext).then(
			(result) => {
				job.result = result
				return result
			},
		)
		this.jobs.set(this.keyFor(request), job)
		return job
	}

	private async generate(
		request: ContextCompactionRequest,
		controller: AbortController,
		allowFullContext: boolean,
	): Promise<GeneratedCompaction> {
		try {
			const plan = await createContextCompressionPlan(
				request.agent,
				request.model,
				allowFullContext ? { allowFullContext: true } : undefined,
			)
			if (!plan) return { status: 'unavailable' }
			if (!this.isCurrent(request)) return { status: 'stale' }
			await request.ensureProviderReady?.()
			if (!this.isCurrent(request)) return { status: 'stale' }
			const summaryContext = await request.resolveSummaryContext()
			const summary = await generateContextCompression({
				provider: request.provider,
				model: request.model,
				session: request.session,
				plan,
				...summaryContext,
				buildMessages: request.buildMessages,
				isCancelled: () => !this.isCurrent(request),
				abortSignal: controller.signal,
			})
			if (!this.isCurrent(request)) return { status: 'stale' }
			return summary ? { status: 'ready', plan, summary } : { status: 'failed' }
		} catch {
			if (request.isCancelled()) return { status: 'cancelled' }
			return { status: controller.signal.aborted ? 'stale' : 'failed' }
		}
	}

	private throwIfCancelled(request: ContextCompactionRequest) {
		if (request.isCancelled()) throw createAbortError('Compaction cancelled')
	}

	private deleteIfCurrent(
		request: ContextCompactionRequest,
		job: ContextCompactionJob,
	) {
		const key = this.keyFor(request)
		if (this.jobs.get(key) === job) this.jobs.delete(key)
	}

	private isCurrent(request: ContextCompactionRequest) {
		return !request.isCancelled() && (request.isCurrent?.() ?? true)
	}

	private keyFor(request: Pick<ContextCompactionRequest, 'session' | 'agent'>) {
		return `${request.session.id}:${request.agent.id}`
	}
}
