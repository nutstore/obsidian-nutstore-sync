import type { App } from 'obsidian'

import {
	findAgent,
	findParentAgent,
	getAgentDepth,
} from '~/ai/chat/agents/agent-tree'
import { MASTER_AGENT_ID } from '~/ai/chat/agents/registry'
import type { ChatSession } from '~/ai/chat/domain'
import {
	getMasterAgent,
	getSessionSubagents,
	isTerminalAgent,
} from '~/ai/chat/domain'
import { extractErrorMessage } from '~/ai/chat/error-utils'
import {
	ContextCompactionCoordinator,
	createContextCompactionRevision,
	type ContextCompactionRequest,
} from '~/ai/chat/runtime/context-compaction-coordinator'
import { AgentRunner } from '~/ai/chat/runtime/agent-runner'
import { runAgentLoop, type AgentLoopError } from '~/ai/chat/runtime/agent-loop'
import { MAX_CONCURRENT_TASKS_PER_SESSION } from '~/ai/chat/prompts'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import type { Selection } from '~/ai/chat/runtime/selection'
import type { ToolExecutor } from '~/ai/chat/runtime/tool-executor'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
import type { AIModelConfig, AIProviderConfig } from '~/ai/core/types'
import { BASH_TMP_MOUNT_POINT } from '~/ai/tools/bash/mount-points'
import { writeBashTmpText } from '~/ai/tools/bash/tmp-fs'
import {
	assertMasterPendingInputsEmpty,
	consumePendingInputs,
} from '~/ai/chat/messages/ui-message'
import type { TaskOrigin } from '~/ai/chat/runtime/master-turn-scheduler'
import i18n from '~/i18n'
import createId, { createUniqueWordId } from '~/utils/create-id'
import type { DispatchTaskParams, DispatchTaskResult } from '~/ai/tools/task'
import { createAbortError } from '~/ai/transport/abort'

export class TaskManager {
	private enqueueMasterAgentInput: (
		sessionId: string,
		input: AppUIMessage,
		origin: TaskOrigin,
	) => boolean = () => false
	private taskOrigins = new Map<string, TaskOrigin>()

	constructor(
		private app: App,
		private ensureProviderReady: (provider: AIProviderConfig) => Promise<void>,
		private state: ChatState,
		private selection: Selection,
		private store: SessionStore,
		private notify: () => void,
		private toolExecutor: ToolExecutor,
		private messageFactory: import('~/ai/chat/messages/message-factory').MessageFactory,
		private agentRunner: AgentRunner,
		compactionCoordinator?: ContextCompactionCoordinator,
	) {
		this.compactionCoordinator =
			compactionCoordinator ??
			new ContextCompactionCoordinator(this.store, this.messageFactory)
	}

	private readonly compactionCoordinator: ContextCompactionCoordinator

	setMasterAgentInputHandler(
		handler: (
			sessionId: string,
			input: AppUIMessage,
			origin: TaskOrigin,
		) => boolean,
	) {
		this.enqueueMasterAgentInput = handler
	}

	async runAgent(
		session: ChatSession,
		agent: ChatAgentState,
		origin: TaskOrigin,
	) {
		if (!this.isAgentExecutionAlive(session, agent, origin)) return
		const selectedModel = agent.model
		if (!selectedModel?.providerId || !selectedModel.modelId) {
			await this.finishAgentAsFailed(
				session,
				agent,
				i18n.t('chatbox.errors.taskSessionUnavailable'),
				origin,
			)
			return
		}

		agent.status = 'running'
		agent.startedAt ??= Date.now()
		try {
			const provider = this.selection.getProviderByIdOrThrow(
				selectedModel.providerId,
			)
			await this.ensureProviderReady(provider)
			const model = this.selection.getModelByIdsOrThrow(
				provider,
				selectedModel.modelId,
			)
			const isTurnAlive = () =>
				this.isAgentExecutionAlive(session, agent, origin)
			const result = await runAgentLoop({
				compactionCoordinator: this.compactionCoordinator,
				createCompactionRequest: () => {
					consumePendingInputs(agent)
					return this.createCompactionRequest(
						session,
						agent,
						provider,
						model,
						isTurnAlive,
					)
				},
				isTurnAlive,
				runTurn: (continuation, shouldSuspendAtSafePoint) =>
					this.agentRunner.runTurn({
						session,
						agent,
						provider,
						model,
						depth: getAgentDepth(getMasterAgent(session), agent.id),
						assistantMeta: {
							providerId: provider.id,
							providerName: provider.name,
							modelId: model.id,
							modelName: model.name,
						},
						isTurnAlive,
						continuation,
						taskOrigin: origin,
						abortSignal: origin.signal,
						shouldSuspendAfterToolStep: shouldSuspendAtSafePoint,
					}),
			})

			if (result.status === 'cancelled') {
				await this.finishAgentAsCancelled(session, agent, origin)
				return
			}
			if (result.status === 'failed') {
				await this.finishAgentAsFailed(
					session,
					agent,
					this.agentLoopErrorMessage(result.error),
					origin,
				)
				return
			}
			if (agent.pendingInputs.length > 0) {
				void this.persistCurrentSession(session)
				void this.runAgent(session, agent, origin)
				return
			}
			if (this.hasActiveChildAgents(agent)) {
				agent.status = 'idle'
				void this.persistCurrentSession(session)
				this.notify()
				return
			}

			await this.finishAgentAsCompleted(session, agent, result.text, origin)
		} catch (error) {
			await this.finishAgentAsFailed(
				session,
				agent,
				extractErrorMessage(error, i18n.t('chatbox.requestFailed')),
				origin,
			)
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
		isTurnAlive: () => boolean,
	): ContextCompactionRequest {
		const selectedModel = agent.model
		// Capture primitive ids at request creation. The selection object can be
		// mutated in place when settings change; retaining the object reference
		// would make the stale-job check observe the new values as if they were
		// the original configuration.
		const selectedProviderId = selectedModel?.providerId
		const selectedModelId = selectedModel?.modelId
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
			isCancelled: () => !isTurnAlive(),
			isCurrent: () => {
				const currentSelection = agent.model
				return (
					isTurnAlive() &&
					currentSelection?.providerId === selectedProviderId &&
					currentSelection?.modelId === selectedModelId &&
					createContextCompactionRevision(session, provider, model) === revision
				)
			},
		}
	}

	async dispatchTask(
		params: DispatchTaskParams,
		origin: TaskOrigin,
	): Promise<DispatchTaskResult> {
		const session = this.state.loadedSessions.get(params.sessionId)
		if (!session) throw new Error(i18n.t('chatbox.errors.sessionNotFound'))
		const parent = findAgent(getMasterAgent(session), params.callerAgentId)
		if (!parent) {
			throw new Error(`Caller agent not found: ${params.callerAgentId}`)
		}
		if (isTerminalAgent(parent)) {
			throw new Error('Caller agent is no longer active')
		}
		if (origin.signal.aborted) {
			throw createAbortError('Task origin cancelled')
		}
		const definition = this.toolExecutor.getAgentDefinition(params.subagentType)
		if (!definition.dispatchable) {
			throw new Error(
				i18n.t('chatbox.errors.agentNotDispatchable', {
					agentType: params.subagentType,
				}),
			)
		}
		const selectedModel =
			this.toolExecutor.getSubagentModelSelection(definition.id) ??
			(session.model ? { ...session.model } : undefined)

		const shouldQueue =
			this.countRunningAgentsForSession(session) >=
			MAX_CONCURRENT_TASKS_PER_SESSION
		const now = Date.now()
		const agentId = await this.createAgentId(session, definition.id)
		if (isTerminalAgent(parent) || origin.signal.aborted) {
			throw createAbortError('Task origin cancelled')
		}
		const agent: ChatAgentState = {
			id: agentId,
			type: definition.id,
			model: selectedModel,
			status: shouldQueue ? 'queued' : 'running',
			createdAt: now,
			startedAt: shouldQueue ? undefined : now,
			timeline: [
				{
					id: createId('message'),
					role: 'user',
					metadata: {
						createdAt: now,
					},
					parts: [{ type: 'text', text: params.prompt }],
				},
			],
			pendingInputs: [],
			operations: {},
			toolTimings: {},
			subagents: {},
		}
		parent.subagents[agent.id] = agent
		this.taskOrigins.set(this.originKey(session.id, agent.id), origin)
		void this.persistCurrentSession(session)
		this.notify()
		if (shouldQueue) this.startQueuedAgentsForSession(session)
		else void this.runAgent(session, agent, origin)

		return {
			taskId: agent.id,
			subagentType: definition.id,
			status: 'dispatched',
		}
	}

	private async createAgentId(session: ChatSession, agentType: string) {
		return createUniqueWordId(agentType, (id) =>
			Boolean(findAgent(getMasterAgent(session), id)),
		)
	}

	private originKey(sessionId: string, agentId: string) {
		return `${sessionId}:${agentId}`
	}

	private isCurrentSession(session: ChatSession) {
		return (
			this.state.loadedSessions.get(session.id) === session &&
			!this.state.deletedSessionIds.has(session.id)
		)
	}

	private isOriginAlive(origin: TaskOrigin) {
		return !origin.signal.aborted
	}

	private isAgentExecutionAlive(
		session: ChatSession,
		agent: ChatAgentState,
		origin: TaskOrigin,
	) {
		return (
			this.isCurrentSession(session) &&
			this.isOriginAlive(origin) &&
			!isTerminalAgent(agent)
		)
	}

	private persistCurrentSession(session: ChatSession) {
		return this.store.persistSession(session, () =>
			this.isCurrentSession(session),
		)
	}

	private async stageParentContinuation(
		session: ChatSession,
		agent: ChatAgentState,
		resultPath: string,
		origin: TaskOrigin,
	) {
		const master = getMasterAgent(session)
		assertMasterPendingInputsEmpty(master)
		const parent = findParentAgent(master, agent.id)
		if (!parent) throw new Error('Task parent is unavailable')
		const input = this.createTaskResultInput(agent.id, resultPath)
		if (!this.isCurrentSession(session) || !this.isOriginAlive(origin))
			return false
		if (parent.id === MASTER_AGENT_ID) {
			if (!this.enqueueMasterAgentInput(session.id, input, origin)) {
				throw new Error('Unable to stage master task continuation')
			}
			return true
		}
		if (isTerminalAgent(parent)) return false
		parent.pendingInputs.push(input)
		try {
			await this.persistCurrentSession(session)
		} catch (error) {
			this.removePendingInput(parent, input)
			throw error
		}
		if (
			!this.isCurrentSession(session) ||
			!this.isOriginAlive(origin) ||
			isTerminalAgent(parent)
		) {
			this.removePendingInput(parent, input)
			return false
		}
		this.wakeSubagent(session, parent.id)
		return true
	}

	/**
	 * Rehydration cancels task execution and clears pending inputs. Recover
	 * unconsumed results from the entire tree through the master scheduler,
	 * since cancelled parents can no longer forward their children’s results.
	 */
	restoreMasterTaskContinuations(session: ChatSession) {
		if (!this.isCurrentSession(session)) return
		const master = getMasterAgent(session)
		for (const agent of getSessionSubagents(session)) {
			if (!isTerminalAgent(agent) || !agent.resultPath) continue
			if (this.hasTaskResultNotification(master, agent.id)) continue
			const parent = findParentAgent(master, agent.id)
			if (!parent) continue
			if (
				parent.id !== MASTER_AGENT_ID &&
				(!isTerminalAgent(parent) ||
					this.hasTaskResultNotification(parent, agent.id))
			)
				continue
			const origin: TaskOrigin = {
				turnId: createId('turn'),
				signal: new AbortController().signal,
			}
			if (
				!this.enqueueMasterAgentInput(
					session.id,
					this.createTaskResultInput(agent.id, agent.resultPath),
					origin,
				)
			) {
				throw new Error('Unable to restore master task continuation')
			}
		}
	}

	private createTaskResultInput(
		taskId: string,
		resultPath: string,
	): AppUIMessage {
		return {
			id: createId('input'),
			role: 'user',
			metadata: { createdAt: Date.now() },
			parts: [
				{
					type: 'data-system-notification',
					data: {
						kind: 'task-result-ready',
						taskId,
						resultPath,
					},
				},
			],
		}
	}

	private hasTaskResultNotification(agent: ChatAgentState, taskId: string) {
		return agent.timeline.some((message: AppUIMessage) =>
			message.parts.some(
				(part) =>
					part.type === 'data-system-notification' &&
					part.data.kind === 'task-result-ready' &&
					part.data.taskId === taskId,
			),
		)
	}

	private removePendingInput(agent: ChatAgentState, input: AppUIMessage) {
		const inputIndex = agent.pendingInputs.indexOf(input)
		if (inputIndex !== -1) agent.pendingInputs.splice(inputIndex, 1)
	}

	private finalizeAgentSettlement(session: ChatSession, agent: ChatAgentState) {
		this.compactionCoordinator.cancel(session.id, agent.id)
		this.cleanupAgentTracking(session.id, agent.id)
		this.startQueuedAgentsForSession(session)
		this.notify()
	}

	private async persistAgentResult(
		session: ChatSession,
		agent: ChatAgentState,
		resultText: string,
	) {
		const resultPath = `${BASH_TMP_MOUNT_POINT}/${session.id}/tasks/${agent.id}.txt`
		await writeBashTmpText(this.app, resultPath, resultText)
		return resultPath
	}

	private wakeSubagent(session: ChatSession, agentId: string) {
		const agent = findAgent(getMasterAgent(session), agentId)
		if (!agent || agent.status === 'running' || isTerminalAgent(agent)) return
		const origin = this.taskOrigins.get(this.originKey(session.id, agent.id))
		if (!origin) throw new Error('Subagent task origin is unavailable')
		agent.status = 'running'
		agent.startedAt ??= Date.now()
		void this.persistCurrentSession(session)
		void this.runAgent(session, agent, origin)
	}

	private hasActiveChildAgents(agent: ChatAgentState) {
		return Object.values(agent.subagents).some(
			(child) => !isTerminalAgent(child),
		)
	}

	async finishAgentAsCompleted(
		session: ChatSession,
		agent: ChatAgentState,
		summary: string,
		origin: TaskOrigin,
	) {
		await this.settleAgent(
			session,
			agent,
			summary || i18n.t('chatbox.task.emptyResult'),
			'completed',
			origin,
		)
	}

	async finishAgentAsFailed(
		session: ChatSession,
		agent: ChatAgentState,
		message: string,
		origin: TaskOrigin,
	) {
		await this.settleAgent(session, agent, message, 'failed', origin)
	}

	async finishAgentAsCancelled(
		session: ChatSession,
		agent: ChatAgentState,
		origin: TaskOrigin,
	) {
		await this.settleAgent(
			session,
			agent,
			i18n.t('chatbox.task.cancelledSummary', { task: agent.id }),
			'cancelled',
			origin,
		)
	}

	private async settleAgent(
		session: ChatSession,
		agent: ChatAgentState,
		resultText: string,
		status: 'completed' | 'failed' | 'cancelled',
		origin: TaskOrigin,
	) {
		if (
			!this.isAgentExecutionAlive(session, agent, origin) ||
			agent.status !== 'running'
		)
			return
		const resultPath = await this.persistAgentResult(session, agent, resultText)
		if (
			!this.isAgentExecutionAlive(session, agent, origin) ||
			agent.status !== 'running'
		)
			return
		agent.status = status
		agent.finishedAt = Date.now()
		agent.resultPath = resultPath
		try {
			await this.persistCurrentSession(session)
			if (this.isCurrentSession(session) && this.isOriginAlive(origin)) {
				await this.stageParentContinuation(session, agent, resultPath, origin)
			}
		} finally {
			this.finalizeAgentSettlement(session, agent)
		}
	}

	countRunningAgentsForSession(session: ChatSession) {
		return getSessionSubagents(session).filter(
			(agent) => agent.status === 'running',
		).length
	}

	startQueuedAgentsForSession(session: ChatSession) {
		if (this.state.deletedSessionIds.has(session.id)) return
		while (
			this.countRunningAgentsForSession(session) <
			MAX_CONCURRENT_TASKS_PER_SESSION
		) {
			const nextAgent = getSessionSubagents(session)
				.filter((agent) => agent.status === 'queued')
				.sort((left, right) => left.createdAt - right.createdAt)[0]
			if (!nextAgent) return
			const origin = this.taskOrigins.get(
				this.originKey(session.id, nextAgent.id),
			)
			if (!origin) throw new Error('Subagent task origin is unavailable')
			nextAgent.status = 'running'
			nextAgent.startedAt ??= Date.now()
			void this.persistCurrentSession(session)
			this.notify()
			void this.runAgent(session, nextAgent, origin)
		}
	}

	cancelAllNonTerminalAgents(session: ChatSession, originTurnId?: string) {
		let changed = false
		for (const agent of getSessionSubagents(session)) {
			if (isTerminalAgent(agent)) continue
			if (
				originTurnId &&
				this.taskOrigins.get(this.originKey(session.id, agent.id))?.turnId !==
					originTurnId
			)
				continue
			agent.status = 'cancelled'
			agent.finishedAt = Date.now()
			this.compactionCoordinator.cancel(session.id, agent.id)
			this.cleanupAgentTracking(session.id, agent.id)
			changed = true
		}
		return changed
	}

	cleanupSessionAgentTracking(session: ChatSession) {
		for (const agent of getSessionSubagents(session)) {
			this.compactionCoordinator.cancel(session.id, agent.id)
			this.cleanupAgentTracking(session.id, agent.id)
		}
		const prefix = `${session.id}:`
		for (const [key] of this.taskOrigins) {
			if (!key.startsWith(prefix)) continue
			const agentId = key.slice(prefix.length)
			this.compactionCoordinator.cancel(session.id, agentId)
			this.taskOrigins.delete(key)
		}
	}

	private cleanupAgentTracking(sessionId: string, agentId: string) {
		this.taskOrigins.delete(this.originKey(sessionId, agentId))
	}
}
