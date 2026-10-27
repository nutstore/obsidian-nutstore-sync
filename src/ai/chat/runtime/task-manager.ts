import type { App } from 'obsidian'
import type {
	AgentAddress,
	AgentCommunication,
	AgentWakeReason,
} from '~/ai/tools/agent-communication'

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
	removeIncompleteToolCalls,
	stagePendingInput,
	commitPendingInput,
	hasPendingInputs,
	consumePendingInputs,
} from '~/ai/chat/messages/ui-message'
import type { TaskOrigin } from '~/ai/chat/runtime/master-turn-scheduler'
import i18n from '~/i18n'
import createId, { createUniqueWordId } from '~/utils/create-id'
import type { DispatchTaskParams, DispatchTaskResult } from '~/ai/tools/task'
import { createAbortError } from '~/utils/abort'

export class TaskManager implements AgentCommunication {
	private executing = new Map<string, Promise<void>>()
	private executionControllers = new Map<string, AbortController>()
	private settlements = new Map<string, Promise<void>>()
	private uncommittedExecutions = new WeakSet<ChatAgentState>()
	private hasUserInput: (sessionId: string) => boolean = () => false

	setUserInputPendingHandler(handler: (sessionId: string) => boolean) {
		this.hasUserInput = handler
	}
	private waiters = new Map<
		string,
		{
			finish: (reason: AgentWakeReason) => void
			origin: TaskOrigin
			reason?: AgentWakeReason
		}
	>()
	/** Validate both endpoints against the live session; IDs are never global. */
	private resolveAddress(address: AgentAddress) {
		const session = this.state.loadedSessions.get(address.sessionId)
		if (!session || !this.isCurrentSession(session))
			throw new Error('Session is unavailable')
		if (address.origin.signal.aborted)
			throw createAbortError('Task origin cancelled')
		const agent = findAgent(getMasterAgent(session), address.agentId)
		if (!agent) throw new Error('Caller agent is unavailable')
		return { session, agent }
	}

	listAgents(address: AgentAddress) {
		const { session } = this.resolveAddress(address)
		const master = getMasterAgent(session)
		return [master, ...getSessionSubagents(session)].map((agent) => ({
			id: agent.id,
			type: agent.type,
			status: agent.status,
			parent: findParentAgent(master, agent.id)?.id,
		}))
	}

	async sendMessage(
		address: AgentAddress,
		targetId: string,
		message: string,
		followup = false,
	) {
		const { session, agent: sender } = this.resolveAddress(address)
		const target = findAgent(getMasterAgent(session), targetId)
		if (!target) throw new Error('Target agent is unavailable in this session')
		if (target === sender) throw new Error('Cannot send a message to yourself')
		if (!message.trim()) throw new Error('Message must not be blank')
		if (followup && target.id === MASTER_AGENT_ID)
			throw new Error('Cannot assign a follow-up task to the master agent')
		const now = Date.now()
		const input: AppUIMessage = {
			id: createId('input'),
			role: 'user',
			metadata: { createdAt: now },
			parts: [
				{
					type: 'data-system-notification',
					data: {
						kind: followup ? 'followup-task' : 'agent-message',
						sender: sender.id,
						recipient: target.id,
						message,
						createdAt: now,
					},
				},
			],
		}
		await this.deliverInput(session, target, input)
		if (!this.isCurrentSession(session) || address.origin.signal.aborted)
			return { messageId: input.id }
		const settlement = this.settlements.get(
			`${this.originKey(session.id, target.id)}:${target.executionId ?? 'legacy'}`,
		)
		if (
			followup &&
			(settlement || isTerminalAgent(target) || target.status === 'idle')
		) {
			// No new loop may overlap the old loop's asynchronous settlement.
			if (settlement) await settlement
			const previous = this.executing.get(this.originKey(session.id, target.id))
			if (previous) await previous
			if (!this.isCurrentSession(session) || address.origin.signal.aborted)
				return { messageId: input.id }
			if (target.status === 'idle') {
				// Delegated work still belongs to this execution and its initiator.
				this.wakeSubagent(session, target.id)
			} else if (isTerminalAgent(target)) {
				const previousState = {
					status: target.status,
					executionId: target.executionId,
					executions: target.executions?.slice(),
					resultPath: target.resultPath,
					startedAt: target.startedAt,
					finishedAt: target.finishedAt,
				}
				this.beginExecution(session, target, sender.id, address.origin)
				try {
					await this.persistCurrentSession(session)
					this.uncommittedExecutions.delete(target)
				} catch (error) {
					this.uncommittedExecutions.delete(target)
					Object.assign(target, previousState)
					this.taskOrigins.delete(this.originKey(session.id, target.id))
					throw error
				}
				if (this.isCurrentSession(session) && !address.origin.signal.aborted)
					this.startQueuedAgentsForSession(session)
			}
		}
		return { messageId: input.id }
	}

	private beginExecution(
		session: ChatSession,
		agent: ChatAgentState,
		initiator: string,
		origin: TaskOrigin,
	) {
		this.ensureExecutionHistory(session, agent)
		this.uncommittedExecutions.add(agent)
		const execution = { id: createId('run'), initiator, createdAt: Date.now() }
		;(agent.executions ??= []).push(execution)
		agent.executionId = execution.id
		agent.status = 'queued'
		agent.startedAt = undefined
		agent.finishedAt = undefined
		agent.resultPath = undefined
		removeIncompleteToolCalls(agent)
		this.taskOrigins.set(this.originKey(session.id, agent.id), origin)
	}

	/** Legacy artifacts remain immutable, with a deterministic identity for deduplication. */
	private ensureExecutionHistory(session: ChatSession, agent: ChatAgentState) {
		if (agent.executions?.length || !agent.resultPath) return
		const id = `legacy-${agent.id}`
		agent.executions = [
			{
				id,
				initiator:
					findParentAgent(getMasterAgent(session), agent.id)?.id ??
					MASTER_AGENT_ID,
				createdAt: agent.createdAt,
				finishedAt: agent.finishedAt,
				status: isTerminalAgent(agent)
					? (agent.status as 'completed' | 'failed' | 'cancelled')
					: undefined,
				resultPath: agent.resultPath,
			},
		]
		agent.executionId = id
	}

	private async deliverInput(
		session: ChatSession,
		target: ChatAgentState,
		input: AppUIMessage,
	) {
		if (
			[...target.timeline, ...target.pendingInputs].some(
				(item) => item.id === input.id,
			)
		)
			return
		// Persist before exposing input to a model boundary or waking an execution.
		// An uncommitted entry blocks consumption of all later inbox entries.
		stagePendingInput(target, input)
		try {
			await this.persistCurrentSession(session)
		} catch (error) {
			this.removePendingInput(target, input)
			throw error
		} finally {
			commitPendingInput(input)
		}
		if (!this.isCurrentSession(session)) return
		this.wakeWaiter(
			session,
			target.id,
			input.parts.some(
				(part) =>
					part.type === 'data-system-notification' &&
					part.data.kind === 'task-result-ready',
			)
				? 'task-completed'
				: 'message',
		)
		this.notify()
	}

	waitAgent(
		address: AgentAddress,
		timeoutMs = 30000,
	): Promise<{ reason: AgentWakeReason }> {
		if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000)
			throw new Error('timeout_ms must be between 1000 and 600000')
		const { session, agent } = this.resolveAddress(address)
		const key = this.originKey(session.id, agent.id)
		if (this.waiters.has(key)) throw new Error('Agent is already waiting')
		if (isTerminalAgent(agent)) throw new Error('Agent execution has ended')
		if (this.hasUserInput(session.id))
			return Promise.resolve({ reason: 'user-input' })
		const pending = hasPendingInputs(agent) ? agent.pendingInputs[0] : undefined
		if (pending)
			return Promise.resolve({
				reason: pending.parts.some(
					(part) =>
						part.type === 'data-system-notification' &&
						part.data.kind === 'task-result-ready',
				)
					? 'task-completed'
					: 'message',
			})
		return new Promise((resolve) => {
			const abort = () => this.wakeWaiter(session, agent.id, 'cancelled')
			// eslint-disable-next-line obsidianmd/prefer-window-timers -- Session execution is independent of any popout window.
			const timer = setTimeout(
				() => this.wakeWaiter(session, agent.id, 'timeout'),
				timeoutMs,
			)
			this.waiters.set(key, {
				finish: (reason) => {
					// eslint-disable-next-line obsidianmd/prefer-window-timers -- Matches the session-owned timer.
					clearTimeout(timer)
					address.origin.signal.removeEventListener('abort', abort)
					resolve({ reason })
				},
				origin: address.origin,
			})
			address.origin.signal.addEventListener('abort', abort, { once: true })
			agent.status = 'waiting'
			this.notify()
			this.startQueuedAgentsForSession(session)
		})
	}

	wakeForUserInput(sessionId: string) {
		const session = this.state.loadedSessions.get(sessionId)
		if (!session) return
		for (const agent of [
			getMasterAgent(session),
			...getSessionSubagents(session),
		])
			this.wakeWaiter(session, agent.id, 'user-input')
	}

	private wakeWaiter(
		session: ChatSession,
		agentId: string,
		reason: AgentWakeReason,
	) {
		const key = this.originKey(session.id, agentId)
		const waiter = this.waiters.get(key)
		if (!waiter || (waiter.reason && reason !== 'cancelled')) return
		waiter.reason = reason
		const agent = findAgent(getMasterAgent(session), agentId)
		if (
			!agent ||
			reason === 'cancelled' ||
			!this.isCurrentSession(session) ||
			waiter.origin.signal.aborted
		) {
			this.waiters.delete(key)
			if (agent && agent.id !== MASTER_AGENT_ID) {
				agent.status = 'cancelled'
				agent.finishedAt = Date.now()
				const execution = agent.executions?.find(
					(run) => run.id === agent.executionId,
				)
				if (execution && !execution.status)
					Object.assign(execution, {
						status: 'cancelled',
						finishedAt: agent.finishedAt,
					})
			}
			waiter.finish('cancelled')
			return
		}
		if (agentId === MASTER_AGENT_ID) {
			agent.status = 'running'
			this.waiters.delete(key)
			waiter.finish(reason)
		} else {
			agent.status = 'queued'
			this.startQueuedAgentsForSession(session)
		}
		this.notify()
	}

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

	runAgent(
		session: ChatSession,
		agent: ChatAgentState,
		origin: TaskOrigin,
	): Promise<void> {
		const key = this.originKey(session.id, agent.id)
		const existing = this.executing.get(key)
		if (existing) return existing
		const controller = new AbortController()
		const abort = () => controller.abort(origin.signal.reason)
		if (origin.signal.aborted) abort()
		else origin.signal.addEventListener('abort', abort, { once: true })
		this.executionControllers.set(key, controller)
		const work = this.executeAgent(session, agent, {
			...origin,
			signal: controller.signal,
		})
			.catch((error: unknown) => {
				if (!this.isCurrentSession(session) || controller.signal.aborted) return
				// A storage failure must not leave a phantom running task or an unhandled promise.
				agent.status = 'failed'
				agent.finishedAt = Date.now()
				const execution = agent.executions?.find(
					(run) => run.id === agent.executionId,
				)
				if (execution && !execution.status)
					Object.assign(execution, {
						status: 'failed',
						finishedAt: agent.finishedAt,
					})
				agent.timeline.push({
					id: createId('message'),
					role: 'assistant',
					metadata: { createdAt: Date.now(), status: 'error' },
					parts: [
						{
							type: 'text',
							text: extractErrorMessage(error, i18n.t('chatbox.requestFailed')),
						},
					],
				})
				this.finalizeAgentSettlement(session, agent)
			})
			.finally(() => {
				origin.signal.removeEventListener('abort', abort)
				if (this.executionControllers.get(key) === controller)
					this.executionControllers.delete(key)
				if (this.executing.get(key) === work) this.executing.delete(key)
				this.startQueuedAgentsForSession(session)
			})
		this.executing.set(key, work)
		return work
	}

	private async executeAgent(
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
			let result
			do {
				result = await runAgentLoop({
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
			} while (
				result.status === 'completed' &&
				hasPendingInputs(agent) &&
				isTurnAlive()
			)

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
			if (this.hasOutstandingTasks(session, agent)) {
				agent.status = 'idle'
				this.startQueuedAgentsForSession(session)
				void this.persistCurrentSession(session).catch(() => this.notify())
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
		const selectedModel = this.resolveSubagentModelSelection(
			this.toolExecutor.getSubagentModelSelection(definition.id),
			session.model,
		)

		const now = Date.now()
		const agentId = await this.createAgentId(session, definition.id)
		if (isTerminalAgent(parent) || origin.signal.aborted) {
			throw createAbortError('Task origin cancelled')
		}
		const agent: ChatAgentState = {
			id: agentId,
			type: definition.id,
			model: selectedModel,
			status: 'queued',
			createdAt: now,
			startedAt: undefined,
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
		this.beginExecution(session, agent, parent.id, origin)
		try {
			await this.persistCurrentSession(session)
		} catch (error) {
			this.uncommittedExecutions.delete(agent)
			delete parent.subagents[agent.id]
			this.cleanupAgentTracking(session.id, agent.id)
			throw error
		}
		this.uncommittedExecutions.delete(agent)
		this.notify()
		if (this.isCurrentSession(session) && !origin.signal.aborted)
			this.startQueuedAgentsForSession(session)

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

	private resolveSubagentModelSelection(
		configuredModel: ChatSession['model'],
		fallbackModel: ChatSession['model'],
	) {
		if (!configuredModel) {
			return fallbackModel ? { ...fallbackModel } : undefined
		}
		try {
			const provider = this.selection.getProviderByIdOrThrow(
				configuredModel.providerId,
			)
			this.selection.getModelByIdsOrThrow(provider, configuredModel.modelId)
			return { ...configuredModel }
		} catch {
			return fallbackModel ? { ...fallbackModel } : undefined
		}
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
		const execution = agent.executions?.find(
			(run) => run.id === agent.executionId,
		)
		const parent = execution
			? findAgent(master, execution.initiator)
			: findParentAgent(master, agent.id)
		if (!parent) throw new Error('Task initiator is unavailable')
		const input = this.createTaskResultInput(
			agent.id,
			resultPath,
			execution?.id,
			parent.id,
		)
		if (!this.isCurrentSession(session) || !this.isOriginAlive(origin))
			return false
		await this.deliverInput(session, parent, input)
		if (!this.isCurrentSession(session) || !this.isOriginAlive(origin))
			return false
		if (parent.id === MASTER_AGENT_ID) {
			if (!this.enqueueMasterAgentInput(session.id, input, origin))
				throw new Error('Unable to stage master task continuation')
		} else if (!isTerminalAgent(parent)) this.wakeSubagent(session, parent.id)
		return true
	}

	/** Reload retains input, but never implicitly executes historical work. */
	restoreMasterTaskContinuations(session: ChatSession) {
		if (!this.isCurrentSession(session)) return
		const master = getMasterAgent(session)
		for (const agent of getSessionSubagents(session)) {
			this.ensureExecutionHistory(session, agent)
			for (const execution of agent.executions ?? []) {
				if (!execution.resultPath) continue
				const target = findAgent(master, execution.initiator) ?? master
				if (
					[master, ...getSessionSubagents(session)].some((recipient) =>
						this.hasTaskResultNotification(
							recipient,
							agent.id,
							execution.id,
							execution.resultPath!,
						),
					)
				)
					continue
				const input = this.createTaskResultInput(
					agent.id,
					execution.resultPath,
					execution.id,
					target.id,
				)
				target.pendingInputs.push(input)
			}
		}
	}

	private createTaskResultInput(
		taskId: string,
		resultPath: string,
		runId?: string,
		recipient?: string,
	): AppUIMessage {
		return {
			id: `result:${taskId}:${runId ?? 'legacy'}`,
			role: 'user',
			metadata: { createdAt: Date.now() },
			parts: [
				{
					type: 'data-system-notification',
					data: {
						kind: 'task-result-ready',
						taskId,
						resultPath,
						runId,
						sender: taskId,
						recipient,
						createdAt: Date.now(),
					},
				},
			],
		}
	}

	private hasTaskResultNotification(
		agent: ChatAgentState,
		taskId: string,
		runId: string,
		resultPath: string,
	) {
		return [...agent.timeline, ...agent.pendingInputs].some(
			(message: AppUIMessage) =>
				message.parts.some(
					(part) =>
						part.type === 'data-system-notification' &&
						part.data.kind === 'task-result-ready' &&
						part.data.taskId === taskId &&
						(part.data.runId === runId ||
							(!part.data.runId && part.data.resultPath === resultPath)),
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
		const resultPath = agent.executionId
			? `${BASH_TMP_MOUNT_POINT}/${session.id}/tasks/${agent.id}/${agent.executionId}.txt`
			: `${BASH_TMP_MOUNT_POINT}/${session.id}/tasks/${agent.id}.txt`
		await writeBashTmpText(this.app, resultPath, resultText)
		return resultPath
	}

	private wakeSubagent(session: ChatSession, agentId: string) {
		const agent = findAgent(getMasterAgent(session), agentId)
		if (!agent || agent.status === 'running' || isTerminalAgent(agent)) return
		const origin = this.taskOrigins.get(this.originKey(session.id, agent.id))
		if (!origin) throw new Error('Subagent task origin is unavailable')
		if (
			agent.status === 'waiting' ||
			this.waiters.has(this.originKey(session.id, agent.id))
		)
			return
		agent.status = 'queued'
		this.startQueuedAgentsForSession(session)
	}

	private hasOutstandingTasks(session: ChatSession, agent: ChatAgentState) {
		return getSessionSubagents(session).some((task) => {
			if (task === agent || isTerminalAgent(task)) return false
			const execution = task.executions?.find(
				(run) => run.id === task.executionId,
			)
			return execution
				? execution.initiator === agent.id
				: findParentAgent(getMasterAgent(session), task.id)?.id === agent.id
		})
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

	private settleAgent(
		session: ChatSession,
		agent: ChatAgentState,
		resultText: string,
		status: 'completed' | 'failed' | 'cancelled',
		origin: TaskOrigin,
	): Promise<void> {
		const key = `${this.originKey(session.id, agent.id)}:${agent.executionId ?? 'legacy'}`
		const existing = this.settlements.get(key)
		if (existing) return existing
		const work = this.persistSettlement(
			session,
			agent,
			resultText,
			status,
			origin,
		).finally(() => {
			if (this.settlements.get(key) === work) this.settlements.delete(key)
		})
		this.settlements.set(key, work)
		return work
	}

	private async persistSettlement(
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
		const execution = agent.executions?.find(
			(run) => run.id === agent.executionId,
		)
		if (execution)
			Object.assign(execution, {
				status,
				finishedAt: agent.finishedAt,
				resultPath,
			})
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
		if (!this.isCurrentSession(session)) return
		while (
			this.countRunningAgentsForSession(session) <
			MAX_CONCURRENT_TASKS_PER_SESSION
		) {
			const nextAgent = getSessionSubagents(session)
				.filter(
					(agent) =>
						agent.status === 'queued' &&
						!this.uncommittedExecutions.has(agent) &&
						(!this.executing.has(this.originKey(session.id, agent.id)) ||
							this.waiters.get(this.originKey(session.id, agent.id))?.reason),
				)
				.sort((left, right) => left.createdAt - right.createdAt)[0]
			if (!nextAgent) return
			const origin = this.taskOrigins.get(
				this.originKey(session.id, nextAgent.id),
			)
			if (!origin || origin.signal.aborted) {
				nextAgent.status = 'cancelled'
				continue
			}
			nextAgent.status = 'running'
			nextAgent.startedAt ??= Date.now()
			void this.persistCurrentSession(session).catch(() => this.notify())
			this.notify()
			const key = this.originKey(session.id, nextAgent.id)
			const waiter = this.waiters.get(key)
			if (waiter?.reason) {
				this.waiters.delete(key)
				waiter.finish(waiter.reason)
			} else void this.runAgent(session, nextAgent, origin)
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
			this.executionControllers
				.get(this.originKey(session.id, agent.id))
				?.abort(createAbortError('Task cancelled'))
			agent.status = 'cancelled'
			agent.finishedAt = Date.now()
			const execution = agent.executions?.find(
				(run) => run.id === agent.executionId,
			)
			if (execution)
				Object.assign(execution, {
					status: 'cancelled',
					finishedAt: agent.finishedAt,
				})
			this.compactionCoordinator.cancel(session.id, agent.id)
			this.cleanupAgentTracking(session.id, agent.id)
			changed = true
		}
		return changed
	}

	cleanupSessionAgentTracking(session: ChatSession) {
		for (const [key, controller] of this.executionControllers) {
			if (key.startsWith(`${session.id}:`))
				controller.abort(createAbortError('Session execution ended'))
		}
		for (const agent of [
			getMasterAgent(session),
			...getSessionSubagents(session),
		])
			this.wakeWaiter(session, agent.id, 'cancelled')
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
		const key = this.originKey(sessionId, agentId)
		const waiter = this.waiters.get(key)
		this.waiters.delete(key)
		waiter?.finish('cancelled')
		this.taskOrigins.delete(key)
	}
}
