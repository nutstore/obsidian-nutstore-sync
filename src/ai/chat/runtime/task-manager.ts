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
	runContextCompression,
	shouldAutoCompressAgent,
} from '~/ai/chat/runtime/context-compression'
import {
	type AgentRunResult,
	AgentRunner,
} from '~/ai/chat/runtime/agent-runner'
import { MAX_CONCURRENT_TASKS_PER_SESSION } from '~/ai/chat/prompts'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import type { Selection } from '~/ai/chat/runtime/selection'
import type { ToolExecutor } from '~/ai/chat/runtime/tool-executor'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { ChatAgentState } from '~/ai/chat/types'
import type { AIModelConfig, AIProviderConfig } from '~/ai/core/types'
import { writeBashTmpText } from '~/ai/tools/bash/tmp-fs'
import { consumePendingInputs } from '~/ai/chat/messages/ui-message'
import i18n from '~/i18n'
import createId, { createUniqueWordId } from '~/utils/create-id'
import type { DispatchTaskParams, DispatchTaskResult } from '~/ai/tools/task'

export class TaskManager {
	private wakeAgent: (sessionId: string, agentId: string) => void = () => {}

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
	) {}

	setWakeAgentHandler(handler: (sessionId: string, agentId: string) => void) {
		this.wakeAgent = handler
	}

	async runAgent(session: ChatSession, agent: ChatAgentState) {
		const selectedModel = this.state.taskModelSelection.get(agent.id)
		if (!selectedModel?.providerId || !selectedModel.modelId) {
			await this.finishAgentAsFailed(
				session,
				agent,
				i18n.t('chatbox.errors.taskSessionUnavailable'),
			)
			return
		}

		agent.status = 'running'
		try {
			const provider = this.selection.getProviderByIdOrThrow(
				selectedModel.providerId,
			)
			await this.ensureProviderReady(provider)
			const model = this.selection.getModelByIdsOrThrow(
				provider,
				selectedModel.modelId,
			)
			const result = await this.runBackgroundTaskLoop(
				agent,
				session,
				provider,
				model,
			)

			if (result.status === 'cancelled') {
				await this.finishAgentAsCancelled(session, agent)
				return
			}
			if (result.status === 'failed') {
				await this.finishAgentAsFailed(session, agent, result.error)
				return
			}
			if (result.status === 'suspended') {
				throw new Error('Background agent suspended without a resume condition')
			}

			if (agent.pendingInputs.length > 0) {
				void this.store.persistSession(session)
				void this.runAgent(session, agent)
				return
			}
			if (this.hasActiveChildAgents(agent)) {
				agent.status = 'idle'
				void this.store.persistSession(session)
				this.notify()
				return
			}

			await this.finishAgentAsCompleted(session, agent, result.text)
		} catch (error) {
			await this.finishAgentAsFailed(
				session,
				agent,
				extractErrorMessage(error, i18n.t('chatbox.requestFailed')),
			)
		}
	}

	private async runBackgroundTaskLoop(
		agent: ChatAgentState,
		session: ChatSession,
		provider: AIProviderConfig,
		model: AIModelConfig,
	): Promise<AgentRunResult> {
		consumePendingInputs(agent)

		const isCancelled = () =>
			agent.status === 'cancelled' ||
			this.state.deletedSessionIds.has(session.id)
		if (isCancelled()) return { status: 'cancelled' }

		if (shouldAutoCompressAgent(agent, model)) {
			await runContextCompression({
				provider,
				model,
				session,
				agent,
				store: this.store,
				messageFactory: this.messageFactory,
				isCancelled: () =>
					isCancelled() || this.state.deletedSessionIds.has(session.id),
			})
		}

		return this.agentRunner.runTurn({
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
			isCancelled,
			isDeleted: () => this.state.deletedSessionIds.has(session.id),
			shouldSuspendAfterToolStep: isCancelled,
		})
	}

	dispatchTask(params: DispatchTaskParams): Promise<DispatchTaskResult> {
		const session = this.state.loadedSessions.get(params.sessionId)
		if (!session) throw new Error(i18n.t('chatbox.errors.sessionNotFound'))
		const parent = findAgent(getMasterAgent(session), params.callerAgentId)
		if (!parent) {
			throw new Error(`Caller agent not found: ${params.callerAgentId}`)
		}
		const definition = this.toolExecutor.getAgentDefinition(params.subagentType)

		const shouldQueue =
			this.countRunningAgentsForSession(session) >=
			MAX_CONCURRENT_TASKS_PER_SESSION
		const now = Date.now()
		const agentId = this.createAgentId(session, definition.id)
		const agent: ChatAgentState = {
			id: agentId,
			type: definition.id,
			status: shouldQueue ? 'queued' : 'running',
			createdAt: now,
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
			subagents: {},
		}
		parent.subagents[agent.id] = agent
		this.state.taskModelSelection.set(agent.id, session.model)
		void this.store.persistSession(session)
		this.notify()
		if (shouldQueue) this.startQueuedAgentsForSession(session)
		else void this.runAgent(session, agent)

		return Promise.resolve({
			taskId: agent.id,
			subagentType: definition.id,
			status: 'dispatched',
		})
	}

	private createAgentId(session: ChatSession, agentType: string) {
		return createUniqueWordId(agentType, (id) =>
			Boolean(findAgent(getMasterAgent(session), id)),
		)
	}

	private async afterAgentSettled(
		session: ChatSession,
		agent: ChatAgentState,
		resultPath: string,
	) {
		const master = getMasterAgent(session)
		const parent = findParentAgent(master, agent.id) ?? master
		parent.pendingInputs.push({
			id: createId('input'),
			role: 'user',
			metadata: { createdAt: Date.now() },
			parts: [
				{
					type: 'data-system-notification',
					data: {
						kind: 'task-result-ready',
						taskId: agent.id,
						resultPath,
					},
				},
			],
		})
		await this.store.persistSession(session)
		if (parent.id === MASTER_AGENT_ID) {
			this.wakeAgent(session.id, parent.id)
		} else this.wakeSubagent(session, parent.id)
		this.cleanupAgentTracking(agent.id)
		this.startQueuedAgentsForSession(session)
		this.notify()
	}

	private async persistAgentResult(
		session: ChatSession,
		agent: ChatAgentState,
		resultText: string,
	) {
		const resultPath = `/tmp/${session.id}/tasks/${agent.id}.txt`
		await writeBashTmpText(this.app, resultPath, resultText)
		return resultPath
	}

	private wakeSubagent(session: ChatSession, agentId: string) {
		const agent = findAgent(getMasterAgent(session), agentId)
		if (!agent || agent.status === 'running' || isTerminalAgent(agent)) return
		agent.status = 'running'
		void this.store.persistSession(session)
		void this.runAgent(session, agent)
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
	) {
		if (agent.status !== 'running') return
		const text = summary || i18n.t('chatbox.task.emptyResult')
		const resultPath = await this.persistAgentResult(session, agent, text)
		agent.status = 'completed'
		await this.afterAgentSettled(session, agent, resultPath)
	}

	async finishAgentAsFailed(
		session: ChatSession,
		agent: ChatAgentState,
		message: string,
	) {
		if (agent.status !== 'queued' && agent.status !== 'running') return
		const resultPath = await this.persistAgentResult(session, agent, message)
		agent.status = 'failed'
		await this.afterAgentSettled(session, agent, resultPath)
	}

	async finishAgentAsCancelled(session: ChatSession, agent: ChatAgentState) {
		if (agent.status !== 'queued' && agent.status !== 'running') return
		const text = i18n.t('chatbox.task.cancelledSummary', { task: agent.id })
		const resultPath = await this.persistAgentResult(session, agent, text)
		agent.status = 'cancelled'
		await this.afterAgentSettled(session, agent, resultPath)
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
			nextAgent.status = 'running'
			void this.store.persistSession(session)
			this.notify()
			void this.runAgent(session, nextAgent)
		}
	}

	cancelAllNonTerminalAgents(session: ChatSession) {
		let changed = false
		for (const agent of getSessionSubagents(session)) {
			if (isTerminalAgent(agent)) continue
			agent.status = 'cancelled'
			this.cleanupAgentTracking(agent.id)
			changed = true
		}
		return changed
	}

	cleanupSessionAgentTracking(session: ChatSession) {
		for (const agent of getSessionSubagents(session))
			this.cleanupAgentTracking(agent.id)
	}

	private cleanupAgentTracking(agentId: string) {
		this.state.taskModelSelection.delete(agentId)
	}
}
