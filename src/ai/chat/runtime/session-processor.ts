import type { ModelMessage, ToolSet } from 'ai'
import type { ChatSession } from '~/ai/chat/domain'

import type { UserContextManager } from '~/ai/chat/context/user-context-manager'
import { extractErrorMessage } from '~/ai/chat/error-utils'
import type { MessageFactory } from '~/ai/chat/messages/message-factory'
import { deriveTitle } from '~/ai/chat/messages/message-utils'
import {
	assertMasterPendingInputsEmpty,
	buildAgentMessages,
} from '~/ai/chat/messages/ui-message'
import { runAgentLoop, type AgentLoopError } from '~/ai/chat/runtime/agent-loop'
import type { AgentRunner } from '~/ai/chat/runtime/agent-runner'
import type {
	ChatState,
	SessionRuntimeState,
} from '~/ai/chat/runtime/chat-state'
import { createContextCompactionRevision } from '~/ai/chat/runtime/context-compaction-revision'
import {
	cancelActiveTurn,
	claimNextTurn,
	completeActiveTurn,
	discardCancelledAgentInputs,
	discardQueuedTurns,
	enqueueAgentInput,
	enqueueRegenerate,
	enqueueUserSubmission,
	failActiveTurn,
	hasQueuedTurns,
	isTurnAlive,
	ownsActiveTurn,
	type ActiveMasterTurn,
	type TaskOrigin,
} from '~/ai/chat/runtime/master-turn-scheduler'
import type { RegenerationTransaction } from '~/ai/chat/runtime/regeneration'
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import type { Selection } from '~/ai/chat/runtime/selection'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type {
	AppUIMessage,
	ChatAgentState,
	ChatSubmission,
} from '~/ai/chat/types'
import type { AIModelConfig, AIProviderConfig } from '~/ai/core/types'
import { createAbortError } from '~/ai/transport/abort'
import i18n from '~/i18n'

interface MessageOpsPort {
	beginRegeneration: (
		session: ChatSession,
		targetMessageId: string,
		isCurrent: () => boolean,
	) => Promise<RegenerationTransaction | undefined>
	commitRegeneration: (
		session: ChatSession,
		transaction: RegenerationTransaction,
	) => void
	rollbackRegeneration: (
		session: ChatSession,
		transaction: RegenerationTransaction,
	) => void
}

interface CompactionRequest {
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
	revision: string
	isCurrent?: () => boolean
}

interface CompactionCoordinatorPort {
	inspect(request: CompactionRequest): 'ready' | 'compact'
	compact(request: CompactionRequest): Promise<{
		beforeTokens: number
		afterTokens: number
		revision: string
	}>
	shouldSuspendAtSafePoint(request: CompactionRequest): boolean
	cancel(sessionId: string, agentId?: string): void
}

interface SubagentCancellationPort {
	cancelAllNonTerminalAgents(
		session: ChatSession,
		originTurnId: string,
	): boolean
	startQueuedAgentsForSession(session: ChatSession): void
}

export class SessionProcessor {
	constructor(
		private ensureProviderReady: (provider: AIProviderConfig) => Promise<void>,
		private state: ChatState,
		private runtimeStates: RuntimeStates,
		private store: SessionStore,
		private notify: () => void,
		private selection: Selection,
		private messageFactory: MessageFactory,
		private messageOps: MessageOpsPort,
		private userContextManager: UserContextManager,
		private agentRunner: AgentRunner,
		private compactionCoordinator: CompactionCoordinatorPort,
		private subagentCancellation: SubagentCancellationPort,
		private reportTransientError: (message: string) => void = () => {},
	) {}

	enqueueUserSubmission(sessionId: string, submission: ChatSubmission) {
		if (
			this.state.deletedSessionIds.has(sessionId) ||
			!this.state.loadedSessions.has(sessionId)
		)
			return undefined
		const runtime = this.runtimeStates.get(sessionId)
		const turnId = enqueueUserSubmission(runtime, submission)
		this.notify()
		void this.start(sessionId)
		return turnId
	}

	enqueueAgentInput(
		sessionId: string,
		input: AppUIMessage,
		origin: TaskOrigin,
	) {
		if (
			this.state.deletedSessionIds.has(sessionId) ||
			!this.state.loadedSessions.has(sessionId)
		)
			return false
		const runtime = this.runtimeStates.get(sessionId)
		const turnId = enqueueAgentInput(runtime, input, origin)
		if (!turnId) return false
		this.notify()
		void this.start(sessionId)
		return true
	}

	enqueueRegenerate(sessionId: string, targetMessageId: string) {
		if (
			this.state.deletedSessionIds.has(sessionId) ||
			!this.state.loadedSessions.has(sessionId)
		)
			return false
		const runtime = this.runtimeStates.get(sessionId)
		enqueueRegenerate(runtime, targetMessageId)
		this.notify()
		void this.start(sessionId)
		return true
	}

	discardAgentInputsForOrigin(sessionId: string, originTurnId: string) {
		const runtime = this.runtimeStates.get(sessionId)
		discardQueuedTurns(
			runtime,
			(turn) =>
				turn.kind === 'agent-input' && turn.origin.turnId === originTurnId,
		)
	}

	/** Stop the active master turn and every execution derived from it. */
	async stopActiveTurn(sessionId: string) {
		const session = this.state.loadedSessions.get(sessionId)
		if (!session) return false
		const runtime = this.runtimeStates.get(sessionId)
		const active = runtime.scheduler.active
		if (!active) return false
		this.cancelExecutionTree(
			session,
			active,
			'Stopped by user',
			this.messageFactory.getActiveAgent(session).id,
		)
		return true
	}

	async start(sessionId: string) {
		if (
			this.state.deletedSessionIds.has(sessionId) ||
			!this.state.loadedSessions.has(sessionId)
		)
			return
		const runtime = this.runtimeStates.get(sessionId)
		if (runtime.processing) return runtime.processing

		const worker = this.drain(sessionId)
		let processing: Promise<void>
		processing = worker.then(
			() => this.shutdownWorker(sessionId, runtime, processing),
			(error) => this.shutdownWorker(sessionId, runtime, processing, { error }),
		)
		runtime.processing = processing
		return processing
	}

	private shutdownWorker(
		sessionId: string,
		runtime: SessionRuntimeState,
		processing: Promise<void>,
		failure?: { error: unknown },
	) {
		if (runtime.processing !== processing) return
		if (failure) {
			this.reportTransientError(
				extractErrorMessage(failure.error, i18n.t('chatbox.requestFailed')),
			)
		}
		runtime.processing = undefined
		// Cancelled agent inputs can no longer run; drop them so no queue state
		// outlives the worker that was waiting on it.
		discardCancelledAgentInputs(runtime)
		if (
			hasQueuedTurns(runtime) &&
			!this.state.deletedSessionIds.has(sessionId) &&
			this.state.loadedSessions.has(sessionId)
		) {
			void this.start(sessionId)
			return
		}
		runtime.runState = 'idle'
		this.notify()
	}

	private async drain(sessionId: string) {
		const runtime = this.runtimeStates.get(sessionId)
		const initialSession = this.state.loadedSessions.get(sessionId)
		if (!initialSession) return
		while (
			!this.state.deletedSessionIds.has(sessionId) &&
			this.state.loadedSessions.get(sessionId) === initialSession &&
			this.runtimeStates.get(sessionId) === runtime
		) {
			const session = this.state.loadedSessions.get(sessionId)
			if (!session) return
			assertMasterPendingInputsEmpty(
				this.messageFactory.getActiveAgent(session),
			)
			const active = claimNextTurn(runtime)
			if (!active) return
			await this.runActiveTurn(session, runtime, active)
		}
	}

	private async runActiveTurn(
		session: ChatSession,
		runtime: SessionRuntimeState,
		active: ActiveMasterTurn,
	) {
		const { inputs, abortController } = active
		const { turnId } = inputs[0]
		const agent = this.messageFactory.getActiveAgent(session)
		const taskOrigin: TaskOrigin = {
			turnId,
			signal: abortController.signal,
		}
		const ownsTurn = () =>
			ownsActiveTurn(runtime, turnId, abortController.signal)
		const canMaterialize = () =>
			ownsTurn() &&
			this.state.loadedSessions.get(session.id) === session &&
			!this.state.deletedSessionIds.has(session.id)
		const isAlive = () =>
			isTurnAlive(runtime, session.id, turnId, abortController.signal, (id) =>
				this.state.deletedSessionIds.has(id),
			) && this.state.loadedSessions.get(session.id) === session
		let regeneration: RegenerationTransaction | undefined
		// The transaction may be committed before its persistence completes.
		// Keep that fact local to this turn so cancellation never reapplies its suffix.
		let regenerationCommitted = false
		let assistantMeta:
			| {
					providerId: string
					providerName: string
					modelId: string
					modelName: string
			  }
			| undefined
		let inputMaterializationError: Error | undefined
		const rememberInputMaterializationError = (error: unknown) => {
			inputMaterializationError ??=
				error instanceof Error
					? error
					: new Error('Input materialization failed', { cause: error })
		}

		runtime.runState = 'thinking'
		this.notify()
		try {
			if (!isAlive()) {
				await this.cancelTurn(session, runtime, active, agent)
				return
			}

			for (const input of active.inputs) {
				if (input.kind === 'agent-input' && input.origin.signal.aborted)
					continue
				switch (input.kind) {
					case 'user-submission': {
						let preparedContext:
							| Awaited<
									ReturnType<UserContextManager['prepareUserContextForMessage']>
							  >
							| undefined
						try {
							preparedContext =
								await this.userContextManager.prepareUserContextForMessage(
									input.submission.userContext,
								)
						} catch (error) {
							rememberInputMaterializationError(error)
						}
						if (!canMaterialize()) {
							await this.cancelTurn(session, runtime, active, agent)
							return
						}
						const message = await this.messageFactory.appendUserMessage(
							agent,
							input.submission.text,
							session,
							preparedContext && preparedContext.dedupedItems.length > 0
								? preparedContext.dedupedItems
								: undefined,
							canMaterialize,
						)
						if (!message) {
							await this.cancelTurn(session, runtime, active, agent)
							return
						}
						this.store.upsertSessionIndexItem(session, deriveTitle(session))
						try {
							await this.store.persistSession(session)
						} catch (error) {
							rememberInputMaterializationError(error)
						}
						void this.store.persistMetaAndIndex()
						this.notify()
						break
					}
					case 'agent-input':
						if (
							!this.messageFactory.appendAgentInput(
								agent,
								input.input,
								session,
								isAlive,
							)
						) {
							await this.cancelTurn(session, runtime, active, agent)
							return
						}
						try {
							await this.store.persistSession(session)
						} catch (error) {
							rememberInputMaterializationError(error)
						}
						this.notify()
						break
					case 'regenerate':
						regeneration = await this.messageOps.beginRegeneration(
							session,
							input.targetMessageId,
							isAlive,
						)
						if (!regeneration) {
							if (!isAlive()) {
								await this.cancelTurn(session, runtime, active, agent)
								return
							}
							throw new Error('Regeneration target is no longer available')
						}
						this.notify()
						break
				}
			}
			if (inputMaterializationError) throw inputMaterializationError

			if (!isAlive()) {
				await this.cancelTurn(session, runtime, active, agent, regeneration)
				return
			}

			const resolvedProvider = this.selection.getProviderOrThrow(session)
			const resolvedModel = this.selection.getModelOrThrow(
				resolvedProvider,
				session,
			)
			const currentAssistantMeta = {
				providerId: resolvedProvider.id,
				providerName: resolvedProvider.name,
				modelId: resolvedModel.id,
				modelName: resolvedModel.name,
			}
			assistantMeta = currentAssistantMeta
			const loopResult = await runAgentLoop({
				compactionCoordinator: this.compactionCoordinator,
				createCompactionRequest: () =>
					this.createCompactionRequest(
						session,
						agent,
						resolvedProvider,
						resolvedModel,
						isAlive,
					),
				isTurnAlive: isAlive,
				onStateChange: (state) => {
					if (state === 'compacting') runtime.runState = 'compressing'
					if (state === 'running-turn') runtime.runState = 'thinking'
					this.notify()
				},
				runTurn: async (continuation, shouldSuspendAtSafePoint) => {
					await this.ensureProviderReady(resolvedProvider)
					if (!isAlive()) throw createAbortError('Agent loop cancelled')
					return this.agentRunner.runTurn({
						session,
						agent,
						provider: resolvedProvider,
						model: resolvedModel,
						depth: 0,
						assistantMeta: currentAssistantMeta,
						runtime,
						isTurnAlive: isAlive,
						taskOrigin,
						continuation,
						abortSignal: abortController.signal,
						buildMessages: (currentAgent, tools) =>
							this.buildMessagesForAgent(currentAgent, tools),
						shouldSuspendAfterToolStep: shouldSuspendAtSafePoint,
						// Regeneration owns a detached timeline suffix until commit;
						// finish that transaction before admitting another input.
						shouldYieldAfterToolStep: () =>
							!regeneration && isAlive() && hasQueuedTurns(runtime),
					})
				},
			})

			if (!isAlive() || loopResult.status === 'cancelled') {
				await this.cancelTurn(session, runtime, active, agent, regeneration)
				return
			}
			if (loopResult.status === 'failed') {
				await this.failTurn(
					session,
					runtime,
					active,
					agent,
					this.agentLoopErrorMessage(loopResult.error),
					regeneration,
					assistantMeta,
				)
				return
			}
			if (regeneration) {
				this.messageOps.commitRegeneration(session, regeneration)
				regenerationCommitted = true
				await this.store.persistSession(session)
				if (!isAlive()) {
					await this.cancelTurn(
						session,
						runtime,
						active,
						agent,
						regeneration,
						regenerationCommitted,
					)
					return
				}
			}
			this.compactionCoordinator.cancel(session.id, agent.id)
			if (!completeActiveTurn(runtime, turnId, abortController.signal)) return
		} catch (error) {
			if (!ownsTurn()) return
			if (!isAlive()) {
				await this.cancelTurn(
					session,
					runtime,
					active,
					agent,
					regeneration,
					regenerationCommitted,
				)
				return
			}
			await this.failTurn(
				session,
				runtime,
				active,
				agent,
				extractErrorMessage(error, i18n.t('chatbox.requestFailed')),
				regeneration,
				assistantMeta,
			)
		} finally {
			this.compactionCoordinator.cancel(session.id, agent.id)
			runtime.runState = 'idle'
			if (!this.state.deletedSessionIds.has(session.id)) this.notify()
		}
	}

	private async cancelTurn(
		session: ChatSession,
		runtime: SessionRuntimeState,
		active: ActiveMasterTurn,
		agent: ChatAgentState,
		regeneration?: RegenerationTransaction,
		regenerationCommitted = false,
	) {
		const { turnId } = active.inputs[0]
		if (this.state.loadedSessions.get(session.id) !== session) {
			cancelActiveTurn(runtime, turnId, active.abortController.signal)
			return
		}
		this.cancelExecutionTree(session, active, 'Turn cancelled', agent.id)
		if (regeneration) {
			if (agent.timeline.length > regeneration.prefixLength) {
				this.messageFactory.removeIncompleteToolCalls(agent)
			}
			if (regenerationCommitted) {
				// The completed transaction already restored its suffix.
			} else if (agent.timeline.length > regeneration.prefixLength) {
				this.messageOps.commitRegeneration(session, regeneration)
			} else this.messageOps.rollbackRegeneration(session, regeneration)
		} else this.messageFactory.removeIncompleteToolCalls(agent)
		try {
			if (regeneration) await this.store.persistMetaAndIndex()
			await this.store.persistSession(session)
		} finally {
			cancelActiveTurn(runtime, turnId, active.abortController.signal)
		}
	}

	private async failTurn(
		session: ChatSession,
		runtime: SessionRuntimeState,
		active: ActiveMasterTurn,
		agent: ChatAgentState,
		message: string,
		regeneration?: RegenerationTransaction,
		assistantMeta?: {
			providerId: string
			providerName: string
			modelId: string
			modelName: string
		},
	) {
		const { turnId } = active.inputs[0]
		if (this.state.loadedSessions.get(session.id) !== session) {
			failActiveTurn(runtime, turnId, active.abortController.signal)
			return
		}
		this.cancelExecutionTree(session, active, 'Turn failed', agent.id)
		if (regeneration) {
			this.messageOps.rollbackRegeneration(session, regeneration)
			this.reportTransientError(message)
		} else {
			this.messageFactory.removeIncompleteToolCalls(agent)
			this.messageFactory.reportFatalError(
				session,
				message,
				assistantMeta,
				agent,
			)
		}
		try {
			if (regeneration) await this.store.persistMetaAndIndex()
			await this.store.persistSession(session)
		} finally {
			failActiveTurn(runtime, turnId, active.abortController.signal)
		}
	}

	private agentLoopErrorMessage(error: AgentLoopError) {
		if (error.type !== 'turn-failed') {
			return i18n.t('chatbox.errors.contextCompressionFailed')
		}
		return extractErrorMessage(error.cause, i18n.t('chatbox.requestFailed'))
	}

	private createCompactionRequest(
		session: ChatSession,
		agent: ChatAgentState,
		provider: AIProviderConfig,
		model: AIModelConfig,
		isAlive: () => boolean,
	): CompactionRequest {
		const revision = createContextCompactionRevision(session, provider, model)
		return {
			session,
			agent,
			provider,
			model,
			revision,
			ensureProviderReady: () => this.ensureProviderReady(provider),
			resolveSummaryContext: () =>
				this.agentRunner.resolveSummaryContext(agent, session, model),
			buildMessages: (messages, tools) =>
				this.buildMessagesForAgent(agent, tools, messages),
			isCancelled: () => !isAlive(),
			isCurrent: () =>
				isAlive() &&
				session.model?.providerId === provider.id &&
				session.model?.modelId === model.id &&
				createContextCompactionRevision(session, provider, model) === revision,
		}
	}

	private cancelExecutionTree(
		session: ChatSession,
		active: ActiveMasterTurn,
		reason: string,
		agentId?: string,
	) {
		const { turnId } = active.inputs[0]
		this.compactionCoordinator.cancel(session.id, agentId)
		if (!active.abortController.signal.aborted) {
			active.abortController.abort(createAbortError(reason))
		}
		this.discardAgentInputsForOrigin(session.id, turnId)
		const changed = this.subagentCancellation.cancelAllNonTerminalAgents(
			session,
			turnId,
		)
		if (!changed) return
		void this.store.persistSession(session)
		this.notify()
		this.subagentCancellation.startQueuedAgentsForSession(session)
	}

	private async buildMessagesForAgent(
		agent: ReturnType<MessageFactory['getActiveAgent']>,
		tools: ToolSet,
		timeline?: ReturnType<MessageFactory['getActiveAgent']>['timeline'],
	): Promise<ModelMessage[]> {
		return buildAgentMessages(agent, tools, this.userContextManager, timeline)
	}
}
