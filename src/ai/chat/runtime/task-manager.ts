import { generateAssistantTurn } from '~/ai/core/runtime'
import {
	REPEATED_TOOL_CALL_THRESHOLD,
	ToolCallRepeatState,
	updateToolCallRepeatState,
} from '~/ai/core/tool-call-repeat'
import type {
	AIMessage,
	AIProviderConfig,
	AISession,
	AITaskRecord,
	AIToolExecutionContext,
} from '~/ai/core/types'
import type {
	ChatState,
	DeferredTaskCompletion,
} from '~/ai/chat/runtime/chat-state'
import {
	createQueuedTask,
	createRunningTask,
	isTerminalTask,
	mutateTaskRecord,
	toCancelledTask,
	toCompletedTask,
	toFailedTask,
	toRunningTask,
} from '~/ai/chat/domain'
import type { QueuedChatTask } from '~/ai/chat/types'
import { extractErrorMessage } from '~/ai/chat/error-utils'
import {
	getAssistantToolCalls,
	messageToText,
	toTextParts,
} from '~/ai/chat/messages/message-utils'
import {
	createSubagentSystemPrompt,
	MAX_CONCURRENT_TASKS_PER_SESSION,
} from '~/ai/chat/prompts'
import type { Selection } from '~/ai/chat/runtime/selection'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { ToolExecutor } from '~/ai/chat/runtime/tool-executor'
import i18n from '~/i18n'
import createId from '~/utils/create-id'
import logger from '~/utils/logger'
import type NutstorePlugin from '../../..'

export interface AgentRunResult {
	status: 'completed' | 'failed' | 'cancelled'
	summary?: string
	error?: string
	failureStage?: string
	sourceCount: number
}

export interface SpawnTaskParams {
	prompt: string
	title?: string
	parentTaskId?: string
	depth: number
	maxDepth: number
	sessionId: string
}

export class TaskManager {
	constructor(
		private plugin: NutstorePlugin,
		private state: ChatState,
		private selection: Selection,
		private store: SessionStore,
		private notify: () => void,
		private toolExecutor: ToolExecutor,
	) {}

	async runTask(task: AITaskRecord) {
		const session = this.state.loadedSessions.get(task.sessionId)
		const selection = this.state.taskModelSelection.get(task.id)
		if (!session || !selection?.providerId || !selection.modelId) {
			this.finishTaskAsFailed(
				task,
				i18n.t('chatbox.errors.taskSessionUnavailable'),
				'session_invalid',
			)
			return
		}

		try {
			const provider = this.selection.getProviderByIdOrThrow(
				selection.providerId,
			)
			await this.plugin.nutstoreLlmGatewayService.ensureProviderReady(provider)
			const model = this.selection.getModelByIdsOrThrow(
				provider,
				selection.modelId,
			)
			const result = await this.runBackgroundTaskLoop(
				task,
				session,
				provider,
				model,
			)

			if (task.status === 'cancelled') {
				return
			}

			if (result.status === 'completed') {
				this.finishTaskAsCompleted(
					task,
					result.summary || '',
					result.sourceCount,
				)
				return
			}
			if (result.status === 'cancelled') {
				this.finishTaskAsCancelled(task, 'user_cancelled')
				return
			}
			this.finishTaskAsFailed(
				task,
				result.error || i18n.t('chatbox.requestFailed'),
				result.failureStage,
				result.sourceCount,
			)
		} catch (error) {
			if (task.status === 'cancelled') {
				return
			}
			logger.error(error)
			this.finishTaskAsFailed(
				task,
				extractErrorMessage(error, i18n.t('chatbox.requestFailed')),
				'runtime_error',
			)
		}
	}

	async runBackgroundTaskLoop(
		task: AITaskRecord,
		session: AISession,
		provider: AIProviderConfig,
		model: { id: string },
	): Promise<AgentRunResult> {
		const tools = this.toolExecutor.createToolsForContext(
			session,
			task.depth,
			task.maxDepth,
			task.id,
		)
		const systemPrompt = createSubagentSystemPrompt(task.depth < task.maxDepth)
		const messages: AIMessage[] = [
			{
				role: 'user',
				content: toTextParts(task.prompt),
			},
		]
		let sourceCount = 0
		let repeatState: ToolCallRepeatState = {
			consecutiveCount: 0,
			isRepeatedTooManyTimes: false,
		}

		while (true) {
			if (task.status === 'cancelled') {
				return {
					status: 'cancelled',
					sourceCount,
				}
			}

			await this.plugin.nutstoreLlmGatewayService.ensureProviderReady(provider)
			const response = await generateAssistantTurn({
				provider,
				model: model.id,
				messages,
				systemPrompt,
				tools,
				...session.inferenceParams,
			})
			messages.push(response.message)

			const assistantToolCalls = getAssistantToolCalls(response.message)
			if (!assistantToolCalls?.length) {
				return {
					status: 'completed',
					summary:
						messageToText(response.message).trim() ||
						i18n.t('chatbox.task.emptyResult'),
					sourceCount,
				}
			}

			repeatState = updateToolCallRepeatState(repeatState, assistantToolCalls)
			if (repeatState.isRepeatedTooManyTimes) {
				return {
					status: 'failed',
					error: i18n.t('chatbox.repeatedToolCallsStopped', {
						count: REPEATED_TOOL_CALL_THRESHOLD,
					}),
					failureStage: 'repeated_tool_calls',
					sourceCount,
				}
			}

			const toolMessages = await this.toolExecutor.resolveToolCalls(
				assistantToolCalls,
				tools,
				{
					session,
					depth: task.depth,
					maxDepth: task.maxDepth,
					parentTaskId: task.id,
				},
			)

			for (const item of toolMessages) {
				messages.push(item.message)
				sourceCount += 1
			}
		}
	}

	startSpawnedTask(
		rawArgs: string,
		context: AIToolExecutionContext,
	): Promise<Record<string, unknown>> {
		try {
			const params = JSON.parse(rawArgs) as Record<string, unknown>
			const promptText = this.toolExecutor.requireToolString(
				params.task,
				'task',
			)
			const title =
				typeof params.label === 'string' && params.label.trim()
					? params.label.trim()
					: undefined
			return this.spawnTask({
				prompt: promptText,
				title,
				parentTaskId: context.parentTaskId,
				depth: context.depth + 1,
				maxDepth: context.maxDepth,
				sessionId: context.session.id,
			})
		} catch (error) {
			return Promise.resolve({
				task_id: null,
				parent_task_id: context.parentTaskId ?? null,
				label: null,
				task: null,
				status: 'failed',
				result_summary: null,
				error_summary: error instanceof Error ? error.message : String(error),
				failure_stage: 'invalid_arguments',
				cancel_reason: null,
				depth: context.depth + 1,
				max_depth: context.maxDepth,
				started_at: null,
				finished_at: Date.now(),
				source_count: null,
			})
		}
	}

	spawnTask(params: SpawnTaskParams) {
		const session = this.state.loadedSessions.get(params.sessionId)
		if (!session) {
			return Promise.resolve(
				this.buildImmediateTaskFailurePayload(
					params,
					i18n.t('chatbox.errors.sessionNotFound'),
					'session_invalid',
				),
			)
		}
		if (params.depth > params.maxDepth) {
			return Promise.resolve(
				this.buildImmediateTaskFailurePayload(
					params,
					i18n.t('chatbox.errors.taskDepthExceeded'),
					'depth_limit',
				),
			)
		}

		const shouldQueue =
			this.countRunningTasksForSession(session) >=
			MAX_CONCURRENT_TASKS_PER_SESSION

		const taskId = createId('task')
		const taskBase = {
			id: taskId,
			sessionId: session.id,
			parentTaskId: params.parentTaskId,
			depth: params.depth,
			maxDepth: params.maxDepth,
			title: params.title || params.prompt.slice(0, 48),
			prompt: params.prompt,
			createdAt: Date.now(),
		}
		const task: AITaskRecord = shouldQueue
			? createQueuedTask(taskBase)
			: createRunningTask(taskBase, Date.now())
		const deferred = this.createDeferredTaskCompletion()

		session.tasks = [task, ...session.tasks]
		this.state.taskModelSelection.set(task.id, session.model)
		this.state.pendingTaskCompletions.set(task.id, deferred)
		void this.store.persistSession(session)
		this.notify()

		if (shouldQueue) {
			this.startQueuedTasksForSession(session)
		} else {
			void this.runTask(task)
		}

		return deferred.promise
	}

	afterTaskSettled(task: AITaskRecord) {
		const session = this.state.loadedSessions.get(task.sessionId)
		if (session) void this.store.persistSession(session)
		this.notify()
		this.resolveTaskCompletion(task.id, this.buildTaskToolPayload(task))
		this.cleanupTaskTracking(task.id)
		if (session) this.startQueuedTasksForSession(session)
	}

	finishTaskAsCompleted(
		task: AITaskRecord,
		summary: string,
		sourceCount: number,
	) {
		if (task.status !== 'running') return
		mutateTaskRecord(
			task,
			toCompletedTask(
				task,
				summary || i18n.t('chatbox.task.emptyResult'),
				sourceCount,
				Date.now(),
			),
		)
		this.afterTaskSettled(task)
	}

	finishTaskAsFailed(
		task: AITaskRecord,
		message: string,
		failureStage?: string,
		sourceCount?: number,
	) {
		if (task.status !== 'queued' && task.status !== 'running') return
		mutateTaskRecord(
			task,
			toFailedTask(task, message, Date.now(), failureStage, sourceCount),
		)
		this.afterTaskSettled(task)
	}

	finishTaskAsCancelled(task: AITaskRecord, cancelReason: string) {
		if (task.status === 'queued' || task.status === 'running') {
			mutateTaskRecord(
				task,
				toCancelledTask(
					task,
					cancelReason,
					Date.now(),
					i18n.t('chatbox.task.cancelledSummary', { task: task.title }),
				),
			)
		}
		this.afterTaskSettled(task)
	}

	countRunningTasksForSession(session: AISession) {
		return session.tasks.filter((item) => item.status === 'running').length
	}

	startQueuedTasksForSession(session: AISession) {
		if (this.state.deletedSessionIds.has(session.id)) {
			return
		}
		while (
			this.countRunningTasksForSession(session) <
			MAX_CONCURRENT_TASKS_PER_SESSION
		) {
			const nextTask = session.tasks
				.filter((item) => item.status === 'queued')
				.sort((left, right) => left.createdAt - right.createdAt)[0]

			if (!nextTask) {
				return
			}

			mutateTaskRecord(
				nextTask,
				toRunningTask(nextTask as QueuedChatTask, Date.now()),
			)
			void this.store.persistSession(session)
			this.notify()
			void this.runTask(nextTask)
		}
	}

	cancelAllNonTerminalTasks(session: AISession, cancelReason: string) {
		let changed = false
		for (const task of session.tasks) {
			if (this.isTaskTerminal(task)) {
				continue
			}
			mutateTaskRecord(
				task,
				toCancelledTask(
					task,
					cancelReason,
					Date.now(),
					i18n.t('chatbox.task.cancelledSummary', { task: task.title }),
				),
			)
			this.resolveTaskCompletion(task.id, this.buildTaskToolPayload(task))
			this.cleanupTaskTracking(task.id)
			changed = true
		}
		return changed
	}

	cleanupSessionTaskTracking(session: AISession) {
		for (const task of session.tasks) {
			this.cleanupTaskTracking(task.id)
		}
	}

	isTaskTerminal(task: AITaskRecord) {
		return isTerminalTask(task)
	}

	isTaskDescendantOf(
		session: AISession,
		task: AITaskRecord,
		ancestorTaskId: string,
	): boolean {
		let currentParentId = task.parentTaskId
		while (currentParentId) {
			if (currentParentId === ancestorTaskId) {
				return true
			}
			currentParentId = session.tasks.find(
				(item) => item.id === currentParentId,
			)?.parentTaskId
		}
		return false
	}

	buildTaskToolPayload(task: AITaskRecord) {
		return {
			task_id: task.id,
			parent_task_id: task.parentTaskId ?? null,
			label: task.title,
			task: task.prompt,
			status: task.status,
			result_summary:
				task.status === 'completed' ? (task.summary ?? null) : null,
			error_summary:
				task.status === 'failed' ? task.error || task.summary || null : null,
			failure_stage:
				task.status === 'failed' ? (task.failureStage ?? null) : null,
			cancel_reason:
				task.status === 'cancelled' ? (task.cancelReason ?? null) : null,
			depth: task.depth,
			max_depth: task.maxDepth,
			started_at: 'startedAt' in task ? (task.startedAt ?? null) : null,
			finished_at: 'finishedAt' in task ? (task.finishedAt ?? null) : null,
			source_count:
				task.status === 'completed'
					? task.sourceCount
					: task.status === 'failed'
						? (task.sourceCount ?? null)
						: null,
		}
	}

	buildImmediateTaskFailurePayload(
		params: SpawnTaskParams,
		message: string,
		failureStage: string,
	) {
		return {
			task_id: null,
			parent_task_id: params.parentTaskId ?? null,
			label: params.title || params.prompt.slice(0, 48),
			task: params.prompt,
			status: 'failed',
			result_summary: null,
			error_summary: message,
			failure_stage: failureStage,
			cancel_reason: null,
			depth: params.depth,
			max_depth: params.maxDepth,
			started_at: null,
			finished_at: Date.now(),
			source_count: null,
		}
	}

	createDeferredTaskCompletion(): DeferredTaskCompletion {
		let resolve!: (payload: Record<string, unknown>) => void
		const deferred: DeferredTaskCompletion = {
			promise: new Promise<Record<string, unknown>>((nextResolve) => {
				resolve = nextResolve
			}),
			resolve: (payload) => {
				deferred.settled = true
				resolve(payload)
			},
			settled: false,
		}
		return deferred
	}

	resolveTaskCompletion(taskId: string, payload: Record<string, unknown>) {
		const deferred = this.state.pendingTaskCompletions.get(taskId)
		if (!deferred || deferred.settled) {
			return
		}
		deferred.resolve(payload)
		this.state.pendingTaskCompletions.delete(taskId)
	}

	cleanupTaskTracking(taskId: string) {
		this.state.pendingTaskCompletions.delete(taskId)
		this.state.taskModelSelection.delete(taskId)
	}
}
