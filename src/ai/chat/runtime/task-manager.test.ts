import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parse as parseAgentId } from 'id-agent'
import type { ChatSession } from '~/ai/chat/domain'
import { MessageFactory } from '~/ai/chat/messages/message-factory'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import { ContextCompactionCoordinator } from '~/ai/chat/runtime/context-compaction-coordinator'
import { TaskManager } from '~/ai/chat/runtime/task-manager'
import { normalizeRehydratedExecution } from '~/ai/chat/session/rehydration-execution'
import {
	EXPLORER_AGENT_ID,
	getAgentDefinition,
	MASTER_AGENT_ID,
	MEMORY_AGENT_ID,
} from '~/ai/chat/agents/registry'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
import { BASH_TMP_MOUNT_POINT } from '~/ai/tools/bash/mount-points'
import { createMasterTurnScheduler } from '~/ai/chat/runtime/master-turn-scheduler'
import type { TaskOrigin } from '~/ai/chat/runtime/master-turn-scheduler'

const writeTaskResult = vi.hoisted(() => vi.fn(async () => undefined))
const generateText = vi.hoisted(() => vi.fn())
const NEUTRAL_TEXT = 'Hello 你好 🌿'

function testOrigin(turnId = 'T1'): TaskOrigin {
	return { turnId, signal: new AbortController().signal }
}

function getEnabledExplorerDefinition(agentType: string) {
	const definition = getAgentDefinition(agentType, {
		fullAccess: false,
		subagents: { explorer: { enabled: true } },
	})
	if (!definition) throw new Error(`Unknown agent type: ${agentType}`)
	return definition
}

vi.mock('~/ai/tools/bash/tmp-fs', () => ({
	writeBashTmpText: writeTaskResult,
}))
vi.mock('ai', async (importOriginal) => ({
	...(await importOriginal<typeof import('ai')>()),
	generateText,
}))
vi.mock('~/ai/core/runtime', () => ({
	prepareMessagesForModel: (
		_provider: unknown,
		_model: string,
		messages: unknown,
	) => messages,
	resolveLanguageModel: () => ({ model: {} }),
}))

describe('TaskManager parent notifications', () => {
	beforeEach(() => {
		writeTaskResult.mockClear()
		generateText.mockReset()
	})

	it('persists the result before notifying the direct parent', async () => {
		const events: string[] = []
		writeTaskResult.mockImplementationOnce(async () => {
			events.push('persist-result')
		})
		const master = createEmptyMasterAgent(1)
		const parent: ChatAgentState = {
			...createEmptyMasterAgent(1),
			id: 'parent',
			type: 'subagent',
			status: 'running',
		}
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'child',
			type: 'subagent',
			status: 'running',
		}
		parent.subagents.child = child
		vi.spyOn(parent.pendingInputs, 'push').mockImplementation((...items) => {
			events.push('notify-parent')
			for (const item of items) {
				Array.prototype.push.call(parent.pendingInputs, item)
			}
			return parent.pendingInputs.length
		})
		master.subagents.parent = parent
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 3,
			subagents: { master },
		}
		const state = {
			loadedSessions: new Map([['session', session]]),
			deletedSessionIds: new Set<string>(),
			taskModelSelection: new Map(),
		} as never
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			state,
			{} as never,
			{ persistSession: vi.fn(async () => undefined) } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{} as never,
		)

		await manager.finishAgentAsCompleted(session, child, 'done', testOrigin())
		expect(events).toEqual(['persist-result', 'notify-parent'])

		expect(writeTaskResult).toHaveBeenCalledWith(
			{},
			`${BASH_TMP_MOUNT_POINT}/session/tasks/child.txt`,
			'done',
		)

		expect(master.pendingInputs).toEqual([])
		expect(parent.pendingInputs).toHaveLength(1)
		expect(parent.pendingInputs[0].parts[0]).toMatchObject({
			type: 'data-system-notification',
			data: {
				kind: 'task-result-ready',
				taskId: 'child',
				resultPath: `${BASH_TMP_MOUNT_POINT}/session/tasks/child.txt`,
			},
		})
		expect(parent.pendingInputs[0].parts).toHaveLength(1)
	})

	it('persists a completed child after its origin is stopped', async () => {
		let releasePersist: (() => void) | undefined
		let isPersistCurrent: (() => boolean) | undefined
		const controller = new AbortController()
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'completed-child',
			type: 'subagent',
			status: 'running',
		}
		master.subagents[child.id] = child
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const persistSession = vi.fn(
			(_session: ChatSession, isCurrent?: () => boolean) => {
				isPersistCurrent = isCurrent
				return new Promise<void>((resolve) => {
					releasePersist = resolve
				})
			},
		)
		const handler = vi.fn(() => true)
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			{
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
				taskModelSelection: new Map(),
			} as never,
			{} as never,
			{ persistSession } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{} as never,
		)
		manager.setMasterAgentInputHandler(handler)

		const completion = manager.finishAgentAsCompleted(
			session,
			child,
			NEUTRAL_TEXT,
			{ turnId: 'T1', signal: controller.signal },
		)
		await vi.waitFor(() => expect(persistSession).toHaveBeenCalledTimes(1))
		controller.abort()

		expect(isPersistCurrent?.()).toBe(true)
		releasePersist!()
		await completion

		expect(child.status).toBe('completed')
		expect(handler).not.toHaveBeenCalled()
	})

	it('does not persist again before enqueuing a master continuation', async () => {
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'master-child',
			type: 'subagent',
			status: 'running',
		}
		master.subagents[child.id] = child
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const persistSession = vi.fn(async () => undefined)
		const handler = vi.fn(() => true)
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			{
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
				taskModelSelection: new Map(),
			} as never,
			{} as never,
			{ persistSession } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{} as never,
		)
		manager.setMasterAgentInputHandler(handler)

		await manager.finishAgentAsCompleted(
			session,
			child,
			NEUTRAL_TEXT,
			testOrigin(),
		)

		expect(persistSession).toHaveBeenCalledTimes(1)
		expect(handler).toHaveBeenCalledTimes(1)
	})

	it.each([0, 1, 3])(
		'rebuilds an unconsumed task continuation at depth %s after rehydration',
		(depth) => {
			const master = createEmptyMasterAgent(1)
			const child: ChatAgentState = {
				...createEmptyMasterAgent(2),
				id: 'completed-child',
				type: EXPLORER_AGENT_ID,
				status: 'completed',
				resultPath: `${BASH_TMP_MOUNT_POINT}/session/tasks/completed-child.txt`,
			}
			let parent = master
			for (let level = 0; level < depth; level += 1) {
				const ancestor: ChatAgentState = {
					...createEmptyMasterAgent(1),
					id: `探索 Explorer 🌿 ${level}`,
					type: EXPLORER_AGENT_ID,
					status: 'idle',
				}
				parent.subagents[ancestor.id] = ancestor
				parent = ancestor
			}
			child.id = '记忆 Memory 🌿'
			child.resultPath = `${BASH_TMP_MOUNT_POINT}/session/tasks/${child.id}.txt`
			parent.subagents[child.id] = child
			const pendingInput: AppUIMessage = {
				id: '结果 Result 🌿',
				role: 'user',
				parts: [
					{
						type: 'data-system-notification',
						data: {
							kind: 'task-result-ready',
							taskId: child.id,
							resultPath: child.resultPath,
						},
					},
				],
			}
			if (depth > 0) parent.pendingInputs.push(pendingInput)
			const session: ChatSession = {
				schemaVersion: 2,
				id: 'session',
				createdAt: 1,
				updatedAt: 1,
				subagents: { master },
			}
			const handler = vi.fn(
				(_sessionId: string, _input: AppUIMessage, _origin: TaskOrigin) => true,
			)
			const manager = new TaskManager(
				{} as never,
				vi.fn(),
				{
					loadedSessions: new Map([[session.id, session]]),
					deletedSessionIds: new Set<string>(),
					taskModelSelection: new Map(),
				} as never,
				{} as never,
				{ persistSession: vi.fn(async () => undefined) } as never,
				vi.fn(),
				{} as never,
				{} as never,
				{} as never,
			)
			manager.setMasterAgentInputHandler(handler)

			normalizeRehydratedExecution(session)
			manager.restoreMasterTaskContinuations(session)

			expect(handler).toHaveBeenCalledTimes(1)
			expect(handler.mock.calls[0]?.[0]).toBe(session.id)
			expect(handler.mock.calls[0]?.[1]).toMatchObject({
				role: 'user',
				parts: [
					{
						type: 'data-system-notification',
						data: {
							kind: 'task-result-ready',
							taskId: child.id,
							resultPath: child.resultPath,
						},
					},
				],
			})
			expect(master.pendingInputs).toEqual([])
			expect(parent.pendingInputs).toEqual([])
			if (depth > 0) expect(parent.status).toBe('cancelled')

			// Once the recovered turn is durable, another reload must not replay it.
			master.timeline.push(handler.mock.calls[0]![1])
			handler.mockClear()
			normalizeRehydratedExecution(session)
			manager.restoreMasterTaskContinuations(session)
			expect(handler).not.toHaveBeenCalled()

			// A result already consumed by its direct parent also needs no replay.
			master.timeline = []
			parent.timeline.push(pendingInput)
			manager.restoreMasterTaskContinuations(session)
			expect(handler).not.toHaveBeenCalled()
		},
	)

	it('does not settle or notify when persisting the result fails', async () => {
		writeTaskResult.mockRejectedValueOnce(new Error('disk full'))
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'child',
			type: 'subagent',
			status: 'running',
		}
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		master.subagents.child = child
		const state = {
			loadedSessions: new Map([['session', session]]),
			deletedSessionIds: new Set<string>(),
			taskModelSelection: new Map(),
		} as never
		const persistSession = vi.fn(async () => undefined)
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			state,
			{} as never,
			{ persistSession } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{} as never,
		)

		await expect(
			manager.finishAgentAsCompleted(session, child, 'done', testOrigin()),
		).rejects.toThrow('disk full')

		expect(child.status).toBe('running')
		expect(master.pendingInputs).toEqual([])
		expect(persistSession).not.toHaveBeenCalled()
	})

	it('settles a child when direct parent delivery cannot be staged', async () => {
		const master = createEmptyMasterAgent(1)
		const parent: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'parent',
			type: 'subagent',
			status: 'running',
		}
		const child: ChatAgentState = {
			...createEmptyMasterAgent(3),
			id: 'child',
			type: 'subagent',
			status: 'running',
		}
		parent.subagents[child.id] = child
		master.subagents[parent.id] = parent
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const persistSession = vi
			.fn<() => Promise<void>>()
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('neutral parent delivery failure'))
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			{
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
				taskModelSelection: new Map(),
			} as never,
			{} as never,
			{ persistSession } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{} as never,
		)

		await expect(
			manager.finishAgentAsCompleted(
				session,
				child,
				NEUTRAL_TEXT,
				testOrigin(),
			),
		).rejects.toThrow('neutral parent delivery failure')

		expect(child.status).toBe('completed')
		expect(parent.pendingInputs).toEqual([])
	})

	it('does not deliver an orphaned child result to the master', async () => {
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'orphaned-child',
			type: 'subagent',
			status: 'running',
		}
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const handler = vi.fn(() => true)
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			{
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
				taskModelSelection: new Map(),
			} as never,
			{} as never,
			{ persistSession: vi.fn(async () => undefined) } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{} as never,
		)
		manager.setMasterAgentInputHandler(handler)

		await expect(
			manager.finishAgentAsCompleted(
				session,
				child,
				NEUTRAL_TEXT,
				testOrigin(),
			),
		).rejects.toThrow('Task parent is unavailable')

		expect(child.status).toBe('completed')
		expect(handler).not.toHaveBeenCalled()
	})

	it.each([
		'origin is aborted',
		'session is replaced',
		'parent becomes terminal',
	])(
		'removes a nested continuation when persistence resumes after the %s',
		async (staleCondition) => {
			let releaseDeliveryPersist: (() => void) | undefined
			const controller = new AbortController()
			const master = createEmptyMasterAgent(1)
			const parent: ChatAgentState = {
				...createEmptyMasterAgent(2),
				id: 'parent',
				type: 'subagent',
				status: 'running',
			}
			const child: ChatAgentState = {
				...createEmptyMasterAgent(3),
				id: 'child',
				type: 'subagent',
				status: 'running',
			}
			parent.subagents[child.id] = child
			master.subagents[parent.id] = parent
			const session: ChatSession = {
				schemaVersion: 2,
				id: 'session',
				createdAt: 1,
				updatedAt: 1,
				subagents: { master },
			}
			const state = {
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
				taskModelSelection: new Map(),
			}
			const persistSession = vi
				.fn<() => Promise<void>>()
				.mockResolvedValueOnce(undefined)
				.mockImplementationOnce(
					() =>
						new Promise<void>((resolve) => {
							releaseDeliveryPersist = resolve
						}),
				)
			const manager = new TaskManager(
				{} as never,
				vi.fn(),
				state as never,
				{} as never,
				{ persistSession } as never,
				vi.fn(),
				{} as never,
				{} as never,
				{} as never,
			)

			const completion = manager.finishAgentAsCompleted(
				session,
				child,
				NEUTRAL_TEXT,
				{ turnId: 'T1', signal: controller.signal },
			)
			await vi.waitFor(() => expect(persistSession).toHaveBeenCalledTimes(2))
			if (staleCondition === 'origin is aborted') controller.abort()
			if (staleCondition === 'session is replaced') {
				state.loadedSessions.set(session.id, {
					...session,
					subagents: { master: createEmptyMasterAgent(4) },
				})
			}
			if (staleCondition === 'parent becomes terminal') {
				parent.status = 'cancelled'
			}
			releaseDeliveryPersist!()
			await completion

			expect(child.status).toBe('completed')
			expect(parent.pendingInputs).toEqual([])
		},
	)

	it('completes only a running child', async () => {
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'idle-child',
			type: 'subagent',
			status: 'idle',
		}
		master.subagents[child.id] = child
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			{
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
				taskModelSelection: new Map(),
			} as never,
			{} as never,
			{ persistSession: vi.fn(async () => undefined) } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{} as never,
		)

		await manager.finishAgentAsCompleted(
			session,
			child,
			NEUTRAL_TEXT,
			testOrigin(),
		)

		expect(child.status).toBe('idle')
		expect(writeTaskResult).not.toHaveBeenCalled()
	})

	it('dispatches a typed subagent with an id-agent task id', async () => {
		const master = createEmptyMasterAgent(1)
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			model: { providerId: 'provider', modelId: 'model' },
			subagents: { master },
		}
		const state = {
			loadedSessions: new Map([['session', session]]),
			deletedSessionIds: new Set<string>(),
			taskModelSelection: new Map(),
		} as never
		const toolExecutor = {
			getAgentDefinition: getEnabledExplorerDefinition,
			getSubagentModelSelection: () => undefined,
		}
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			state,
			{} as never,
			{ persistSession: vi.fn(async () => undefined) } as never,
			vi.fn(),
			toolExecutor as never,
			{} as never,
			{} as never,
		)
		vi.spyOn(manager as never, 'runAgent' as never).mockResolvedValue(
			undefined as never,
		)

		const output = await manager.dispatchTask(
			{
				prompt: 'Inspect the vault',
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: 'master',
				sessionId: session.id,
			},
			testOrigin(),
		)

		const parsed = parseAgentId(output.taskId)
		expect(parsed?.prefix).toBe(EXPLORER_AGENT_ID)
		expect(master.subagents[output.taskId]).toMatchObject({
			id: output.taskId,
			type: EXPLORER_AGENT_ID,
			model: { providerId: 'provider', modelId: 'model' },
		})
		expect(output).toMatchObject({
			subagentType: EXPLORER_AGENT_ID,
			status: 'dispatched',
		})
	})

	it('captures the configured subagent model instead of later settings changes', async () => {
		const master = createEmptyMasterAgent(1)
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'neutral-session',
			createdAt: 1,
			updatedAt: 1,
			model: { providerId: 'caller-provider', modelId: 'caller-model' },
			subagents: { master },
		}
		const configuredModel = {
			providerId: 'configured-provider',
			modelId: 'configured-model',
		}
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			{
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
			} as never,
			{} as never,
			{ persistSession: vi.fn(async () => undefined) } as never,
			vi.fn(),
			{
				getAgentDefinition: getEnabledExplorerDefinition,
				getSubagentModelSelection: () => ({ ...configuredModel }),
			} as never,
			{} as never,
			{} as never,
		)
		vi.spyOn(manager as never, 'runAgent' as never).mockResolvedValue(
			undefined as never,
		)

		const task = await manager.dispatchTask(
			{
				prompt: '调查中性内容 🌿',
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: MASTER_AGENT_ID,
				sessionId: session.id,
			},
			testOrigin(),
		)
		configuredModel.modelId = 'changed-after-dispatch'

		expect(master.subagents[task.taskId].model).toEqual({
			providerId: 'configured-provider',
			modelId: 'configured-model',
		})
	})

	it('settles an unavailable configured model and notifies its parent', async () => {
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'neutral-child',
			type: EXPLORER_AGENT_ID,
			model: { providerId: 'missing-provider', modelId: 'missing-model' },
			status: 'running',
		}
		master.subagents[child.id] = child
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'neutral-session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const notifyParent = vi.fn(() => true)
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			{
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
			} as never,
			{
				getProviderByIdOrThrow: () => {
					throw new Error('中性 provider 不可用 🌿')
				},
			} as never,
			{ persistSession: vi.fn(async () => undefined) } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{} as never,
		)
		manager.setMasterAgentInputHandler(notifyParent)

		await manager.runAgent(session, child, testOrigin())

		expect(child.status).toBe('failed')
		expect(child.resultPath).toBe(
			`${BASH_TMP_MOUNT_POINT}/${session.id}/tasks/${child.id}.txt`,
		)
		expect(writeTaskResult).toHaveBeenCalledWith(
			{},
			child.resultPath,
			expect.stringContaining('中性 provider 不可用 🌿'),
		)
		expect(notifyParent).toHaveBeenCalledWith(
			session.id,
			expect.objectContaining({
				parts: [
					expect.objectContaining({
						data: expect.objectContaining({ kind: 'task-result-ready' }),
					}),
				],
			}),
			expect.anything(),
		)
	})

	it('captures master task lineage when dispatching and preserves it for nested tasks', async () => {
		const master = createEmptyMasterAgent(1)
		const controller = new AbortController()
		const origin: TaskOrigin = { turnId: 'T1', signal: controller.signal }
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			model: { providerId: 'provider', modelId: 'model' },
			subagents: { master },
		}
		const state = {
			loadedSessions: new Map([[session.id, session]]),
			deletedSessionIds: new Set<string>(),
			taskModelSelection: new Map(),
			runtimeBySessionId: new Map([
				[
					session.id,
					{
						runState: 'thinking',
						draft: { text: '', userContext: [] },
						scheduler: {
							...createMasterTurnScheduler(),
							active: {
								turn: {
									turnId: 'T1',
									kind: 'user-submission',
									submission: { text: NEUTRAL_TEXT, userContext: [] },
								},
								abortController: controller,
							},
						},
					},
				],
			]),
		} as never
		const toolExecutor = {
			getAgentDefinition: getEnabledExplorerDefinition,
			getSubagentModelSelection: () => undefined,
		}
		const handler = vi.fn(
			(_sessionId: string, _input: AppUIMessage, _origin: TaskOrigin) => true,
		)
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			state,
			{} as never,
			{ persistSession: vi.fn(async () => undefined) } as never,
			vi.fn(),
			toolExecutor as never,
			{} as never,
			{} as never,
		)
		manager.setMasterAgentInputHandler(handler)
		vi.spyOn(manager as never, 'runAgent' as never).mockResolvedValue(
			undefined as never,
		)

		const first = await manager.dispatchTask(
			{
				prompt: NEUTRAL_TEXT,
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: MASTER_AGENT_ID,
				sessionId: session.id,
			},
			origin,
		)
		const firstAgent = master.subagents[first.taskId]
		const second = await manager.dispatchTask(
			{
				prompt: NEUTRAL_TEXT,
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: first.taskId,
				sessionId: session.id,
			},
			origin,
		)

		await manager.finishAgentAsCompleted(
			session,
			firstAgent.subagents[second.taskId],
			NEUTRAL_TEXT,
			origin,
		)
		expect(firstAgent.pendingInputs).toHaveLength(1)
		await manager.finishAgentAsCompleted(
			session,
			firstAgent,
			NEUTRAL_TEXT,
			origin,
		)

		expect(handler).toHaveBeenCalledTimes(1)
		expect(handler.mock.calls[0]?.[2]).toEqual({
			turnId: 'T1',
			signal: controller.signal,
		})
		expect(master.pendingInputs).toEqual([])
	})

	it('cancelling T1 leaves T0 child compaction running', async () => {
		const master = createEmptyMasterAgent(1)
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			model: { providerId: 'provider', modelId: 'model' },
			subagents: { master },
		}
		const state = {
			loadedSessions: new Map([[session.id, session]]),
			deletedSessionIds: new Set<string>(),
			taskModelSelection: new Map(),
		} as never
		const compactionCoordinator = {
			cancel: vi.fn(),
		}
		const toolExecutor = {
			getAgentDefinition: getEnabledExplorerDefinition,
			getSubagentModelSelection: () => undefined,
		}
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			state,
			{} as never,
			{ persistSession: vi.fn(async () => undefined) } as never,
			vi.fn(),
			toolExecutor as never,
			{} as never,
			{} as never,
			compactionCoordinator as never,
		)
		vi.spyOn(manager as never, 'runAgent' as never).mockResolvedValue(
			undefined as never,
		)

		const t0 = await manager.dispatchTask(
			{
				prompt: NEUTRAL_TEXT,
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: MASTER_AGENT_ID,
				sessionId: session.id,
			},
			testOrigin('T0'),
		)
		const t1 = await manager.dispatchTask(
			{
				prompt: NEUTRAL_TEXT,
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: MASTER_AGENT_ID,
				sessionId: session.id,
			},
			testOrigin('T1'),
		)

		manager.cancelAllNonTerminalAgents(session, 'T1')

		expect(master.subagents[t0.taskId].status).toBe('running')
		expect(master.subagents[t1.taskId].status).toBe('cancelled')
		expect(compactionCoordinator.cancel).toHaveBeenCalledWith(
			session.id,
			t1.taskId,
		)
		expect(compactionCoordinator.cancel).not.toHaveBeenCalledWith(
			session.id,
			t0.taskId,
		)
	})

	it('does not revive a task completion cancelled while its result is being written', async () => {
		let releaseWrite: (() => void) | undefined
		writeTaskResult.mockImplementationOnce(
			() =>
				new Promise<undefined>((resolve) => {
					releaseWrite = () => resolve(undefined)
				}),
		)
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'child',
			type: EXPLORER_AGENT_ID,
			status: 'running',
		}
		master.subagents[child.id] = child
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const handler = vi.fn(
			(_sessionId: string, _input: AppUIMessage, _origin: TaskOrigin) => true,
		)
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			{
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
				taskModelSelection: new Map(),
			} as never,
			{} as never,
			{ persistSession: vi.fn(async () => undefined) } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{} as never,
		)
		manager.setMasterAgentInputHandler(handler)

		const completion = manager.finishAgentAsCompleted(
			session,
			child,
			NEUTRAL_TEXT,
			testOrigin(),
		)
		await vi.waitFor(() => expect(writeTaskResult).toHaveBeenCalledTimes(1))
		child.status = 'cancelled'
		child.finishedAt = Date.now()
		releaseWrite!()
		await completion

		expect(child.status).toBe('cancelled')
		expect(handler).not.toHaveBeenCalled()
	})

	it('discards a stale task completion after its session is rehydrated', async () => {
		let releaseWrite: (() => void) | undefined
		writeTaskResult.mockImplementationOnce(
			() =>
				new Promise<undefined>((resolve) => {
					releaseWrite = () => resolve(undefined)
				}),
		)
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'child',
			type: EXPLORER_AGENT_ID,
			status: 'running',
		}
		master.subagents[child.id] = child
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const state = {
			loadedSessions: new Map([[session.id, session]]),
			deletedSessionIds: new Set<string>(),
			taskModelSelection: new Map(),
		}
		const persistSession = vi.fn(async () => undefined)
		const handler = vi.fn(() => true)
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			state as never,
			{} as never,
			{ persistSession } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{} as never,
		)
		manager.setMasterAgentInputHandler(handler)

		const completion = manager.finishAgentAsCompleted(
			session,
			child,
			NEUTRAL_TEXT,
			testOrigin(),
		)
		await vi.waitFor(() => expect(writeTaskResult).toHaveBeenCalledTimes(1))
		state.loadedSessions.set(session.id, {
			...session,
			subagents: { master: createEmptyMasterAgent(3) },
		})
		releaseWrite!()
		await completion

		expect(child.status).toBe('running')
		expect(persistSession).not.toHaveBeenCalled()
		expect(handler).not.toHaveBeenCalled()
	})

	it('does not deliver a settled task after its session is rehydrated', async () => {
		let releasePersist: (() => void) | undefined
		let isPersistCurrent: (() => boolean) | undefined
		const master = createEmptyMasterAgent(1)
		const child: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'child',
			type: EXPLORER_AGENT_ID,
			status: 'running',
		}
		master.subagents[child.id] = child
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const state = {
			loadedSessions: new Map([[session.id, session]]),
			deletedSessionIds: new Set<string>(),
			taskModelSelection: new Map(),
		}
		const persistSession = vi.fn(
			(_session: ChatSession, isCurrent?: () => boolean) => {
				isPersistCurrent = isCurrent
				return new Promise<void>((resolve) => {
					releasePersist = resolve
				})
			},
		)
		const handler = vi.fn(() => true)
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			state as never,
			{} as never,
			{ persistSession } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{} as never,
		)
		manager.setMasterAgentInputHandler(handler)

		const completion = manager.finishAgentAsCompleted(
			session,
			child,
			NEUTRAL_TEXT,
			testOrigin(),
		)
		await vi.waitFor(() => expect(persistSession).toHaveBeenCalledTimes(1))
		state.loadedSessions.set(session.id, {
			...session,
			subagents: { master: createEmptyMasterAgent(3) },
		})
		expect(isPersistCurrent?.()).toBe(false)
		releasePersist!()
		await completion

		expect(handler).not.toHaveBeenCalled()
		expect(master.pendingInputs).toEqual([])
	})

	it('fences master delivery after the origin turn is aborted', async () => {
		const master = createEmptyMasterAgent(1)
		const controller = new AbortController()
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			model: { providerId: 'provider', modelId: 'model' },
			subagents: { master },
		}
		const state = {
			loadedSessions: new Map([[session.id, session]]),
			deletedSessionIds: new Set<string>(),
			taskModelSelection: new Map(),
			runtimeBySessionId: new Map([
				[
					session.id,
					{
						runState: 'thinking',
						draft: { text: '', userContext: [] },
						scheduler: {
							...createMasterTurnScheduler(),
							active: {
								turn: {
									turnId: 'T1',
									kind: 'user-submission',
									submission: { text: NEUTRAL_TEXT, userContext: [] },
								},
								abortController: controller,
							},
						},
					},
				],
			]),
		} as never
		const toolExecutor = {
			getAgentDefinition: getEnabledExplorerDefinition,
			getSubagentModelSelection: () => undefined,
		}
		const handler = vi.fn(
			(_sessionId: string, _input: AppUIMessage, _origin: TaskOrigin) => true,
		)
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			state,
			{} as never,
			{ persistSession: vi.fn(async () => undefined) } as never,
			vi.fn(),
			toolExecutor as never,
			{} as never,
			{} as never,
		)
		manager.setMasterAgentInputHandler(handler)
		vi.spyOn(manager as never, 'runAgent' as never).mockResolvedValue(
			undefined as never,
		)

		const output = await manager.dispatchTask(
			{
				prompt: NEUTRAL_TEXT,
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: MASTER_AGENT_ID,
				sessionId: session.id,
			},
			{ turnId: 'T1', signal: controller.signal },
		)
		controller.abort()
		await manager.finishAgentAsCompleted(
			session,
			master.subagents[output.taskId],
			NEUTRAL_TEXT,
			{ turnId: 'T1', signal: controller.signal },
		)

		expect(handler).not.toHaveBeenCalled()
		expect(master.pendingInputs).toEqual([])
	})

	it('rejects non-dispatchable agent types, including disabled memory', async () => {
		const master = createEmptyMasterAgent(1)
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			model: { providerId: 'provider', modelId: 'model' },
			subagents: { master },
		}
		const state = {
			loadedSessions: new Map([['session', session]]),
			deletedSessionIds: new Set<string>(),
			taskModelSelection: new Map(),
		} as never
		const manager = new TaskManager(
			{} as never,
			vi.fn(),
			state,
			{} as never,
			{ persistSession: vi.fn(async () => undefined) } as never,
			vi.fn(),
			{
				getAgentDefinition: (agentType: string) => {
					const definition = getAgentDefinition(agentType)
					if (!definition) throw new Error(`Unknown agent type: ${agentType}`)
					return definition
				},
				getSubagentModelSelection: () => undefined,
			} as never,
			{} as never,
			{} as never,
		)

		for (const subagentType of [MASTER_AGENT_ID, MEMORY_AGENT_ID]) {
			await expect(
				manager.dispatchTask(
					{
						prompt: 'Inspect neutral notes 检查中性笔记 🌿',
						subagentType,
						callerAgentId: MASTER_AGENT_ID,
						sessionId: session.id,
					},
					testOrigin(),
				),
			).rejects.toThrow('cannot be dispatched')
		}
		expect(master.subagents).toEqual({})
	})

	it('carries tool-call continuation across a compaction resume', async () => {
		const master = createEmptyMasterAgent(1)
		const agent: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'neutral-child',
			type: 'subagent',
			model: { providerId: 'neutral-provider', modelId: 'neutral-model' },
			status: 'running',
			timeline: [
				{
					id: 'neutral-request',
					role: 'user',
					metadata: { createdAt: 1 },
					parts: [{ type: 'text', text: NEUTRAL_TEXT }],
				},
			],
		}
		master.subagents[agent.id] = agent
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'neutral-session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const continuation = {
			consecutiveCount: 2,
			isRepeatedTooManyTimes: false,
		} as never
		const runTurn = vi
			.fn()
			.mockResolvedValueOnce({ status: 'needs-compaction', continuation })
			.mockResolvedValueOnce({ status: 'completed', text: NEUTRAL_TEXT })
		const state = {
			loadedSessions: new Map([[session.id, session]]),
			deletedSessionIds: new Set<string>(),
			taskModelSelection: new Map([
				[
					agent.id,
					{ providerId: 'neutral-provider', modelId: 'neutral-model' },
				],
			]),
		}
		const manager = new TaskManager(
			{} as never,
			vi.fn(async () => undefined),
			state as never,
			{
				getProviderByIdOrThrow: () => ({ id: 'neutral-provider' }),
				getModelByIdsOrThrow: () => ({ id: 'neutral-model' }),
			} as never,
			{ persistSession: vi.fn(async () => undefined) } as never,
			vi.fn(),
			{} as never,
			{} as never,
			{ runTurn } as never,
		)
		manager.setMasterAgentInputHandler(() => true)

		await manager.runAgent(session, agent, testOrigin())

		expect(runTurn.mock.calls[1][0].continuation).toBe(continuation)
	})

	it('settles after one failed hard-pressure summary instead of retrying', async () => {
		generateText.mockResolvedValue({ text: ' \n\t ' })
		const master = createEmptyMasterAgent(1)
		const agent: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'neutral-child',
			type: 'subagent',
			model: { providerId: 'neutral-provider', modelId: 'neutral-model' },
			status: 'running',
			timeline: [
				{
					id: 'neutral-old-user',
					role: 'user',
					metadata: { createdAt: 1 },
					parts: [{ type: 'text', text: NEUTRAL_TEXT.repeat(10_000) }],
				},
				{
					id: 'neutral-old-assistant',
					role: 'assistant',
					metadata: {
						createdAt: 2,
						llm: {
							usage: {
								inputTokens: 86_000,
								outputTokens: 0,
								totalTokens: 86_000,
							} as never,
						},
					},
					parts: [{ type: 'text', text: NEUTRAL_TEXT }],
				},
				{
					id: 'neutral-current-user',
					role: 'user',
					metadata: { createdAt: 3 },
					parts: [{ type: 'text', text: NEUTRAL_TEXT }],
				},
			],
		}
		master.subagents[agent.id] = agent
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'neutral-session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const store = {
			persistSession: vi.fn(async () => undefined),
			persistMetaAndIndex: vi.fn(async () => undefined),
			upsertSessionIndexItem: vi.fn(),
		}
		const factory = new MessageFactory({} as never, vi.fn())
		const coordinator = new ContextCompactionCoordinator(
			store as never,
			factory,
		)
		const runTurn = vi.fn()
		const manager = new TaskManager(
			{} as never,
			vi.fn(async () => undefined),
			{
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
				taskModelSelection: new Map([
					[
						agent.id,
						{ providerId: 'neutral-provider', modelId: 'neutral-model' },
					],
				]),
			} as never,
			{
				getProviderByIdOrThrow: () => ({ id: 'neutral-provider' }),
				getModelByIdsOrThrow: () => ({
					id: 'neutral-model',
					limit: { context: 100_000, output: 10_000 },
				}),
			} as never,
			store as never,
			vi.fn(),
			{} as never,
			factory,
			{
				runTurn,
				resolveSummaryContext: vi.fn(async () => ({})),
			} as never,
			coordinator,
		)
		manager.setMasterAgentInputHandler(() => true)

		await manager.runAgent(session, agent, testOrigin())

		expect(generateText).toHaveBeenCalledTimes(1)
		expect(runTurn).not.toHaveBeenCalled()
		expect(agent.status).toBe('failed')
	})

	it('cancels an optimistic compaction job when an agent settles', async () => {
		let signal: AbortSignal | undefined
		generateText.mockImplementation(
			({ abortSignal }: { abortSignal?: AbortSignal }) => {
				signal = abortSignal
				return new Promise(() => undefined)
			},
		)
		const message = (
			id: string,
			role: 'user' | 'assistant',
			createdAt: number,
		): AppUIMessage => ({
			id,
			role,
			metadata: { createdAt },
			parts: [{ type: 'text', text: `${NEUTRAL_TEXT} ${id}` }],
		})
		const master = createEmptyMasterAgent(1)
		const agent: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'neutral-child',
			type: 'subagent',
			status: 'running',
			timeline: [
				{
					...message('neutral-old-user', 'user', 1),
					parts: [{ type: 'text', text: NEUTRAL_TEXT.repeat(10_000) }],
				},
				message('neutral-old-assistant', 'assistant', 2),
				message('neutral-current-user', 'user', 3),
			],
		}
		agent.timeline[1].metadata!.llm = {
			usage: {
				inputTokens: 82_000,
				outputTokens: 0,
				totalTokens: 82_000,
			} as never,
		}
		master.subagents[agent.id] = agent
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'neutral-session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const store = {
			persistSession: vi.fn(async () => undefined),
			persistMetaAndIndex: vi.fn(async () => undefined),
			upsertSessionIndexItem: vi.fn(),
		}
		const factory = new MessageFactory({} as never, vi.fn())
		const coordinator = new ContextCompactionCoordinator(
			store as never,
			factory,
		)
		const compactionRequest = {
			session,
			agent,
			provider: { id: 'neutral-provider' } as never,
			model: {
				id: 'neutral-model',
				limit: { context: 100_000, output: 10_000 },
			} as never,
			revision: 'neutral-revision',
			resolveSummaryContext: async () => ({}),
			isCancelled: () => false,
			isCurrent: () => true,
		}
		expect(coordinator.inspect(compactionRequest)).toBe('ready')
		await vi.waitFor(() => expect(signal).toBeDefined())

		const manager = new TaskManager(
			{} as never,
			vi.fn(async () => undefined),
			{
				loadedSessions: new Map([[session.id, session]]),
				deletedSessionIds: new Set<string>(),
				taskModelSelection: new Map(),
			} as never,
			{} as never,
			store as never,
			vi.fn(),
			{} as never,
			factory,
			{} as never,
			coordinator,
		)
		manager.setMasterAgentInputHandler(() => true)

		await manager.finishAgentAsCompleted(
			session,
			agent,
			NEUTRAL_TEXT,
			testOrigin(),
		)

		expect(signal!.aborted).toBe(true)
		expect(generateText).toHaveBeenCalledTimes(1)
	})
})
