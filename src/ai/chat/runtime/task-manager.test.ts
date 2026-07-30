import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parse as parseAgentId } from 'id-agent'
import type { ChatSession } from '~/ai/chat/domain'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import { TaskManager } from '~/ai/chat/runtime/task-manager'
import {
	EXPLORER_AGENT_ID,
	getAgentDefinition,
	MASTER_AGENT_ID,
} from '~/ai/chat/agents/registry'
import type { ChatAgentState } from '~/ai/chat/types'

const writeTaskResult = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('~/ai/tools/bash/tmp-fs', () => ({
	writeBashTmpText: writeTaskResult,
}))

describe('TaskManager parent notifications', () => {
	beforeEach(() => writeTaskResult.mockClear())

	it('persists the result before notifying the direct parent', async () => {
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

		await manager.finishAgentAsCompleted(session, child, 'done')

		expect(writeTaskResult).toHaveBeenCalledWith(
			{},
			'/tmp/session/tasks/child.txt',
			'done',
		)

		expect(master.pendingInputs).toEqual([])
		expect(parent.pendingInputs).toHaveLength(1)
		expect(parent.pendingInputs[0].parts[0]).toMatchObject({
			type: 'data-system-notification',
			data: {
				kind: 'task-result-ready',
				taskId: 'child',
				resultPath: '/tmp/session/tasks/child.txt',
			},
		})
		expect(parent.pendingInputs[0].parts).toHaveLength(1)
	})

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
			manager.finishAgentAsCompleted(session, child, 'done'),
		).rejects.toThrow('disk full')

		expect(child.status).toBe('running')
		expect(master.pendingInputs).toEqual([])
		expect(persistSession).not.toHaveBeenCalled()
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
			getAgentDefinition: (agentType: string) => {
				const definition = getAgentDefinition(agentType)
				if (!definition) throw new Error(`Unknown agent type: ${agentType}`)
				return definition
			},
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

		const output = await manager.dispatchTask({
			prompt: 'Inspect the vault',
			subagentType: EXPLORER_AGENT_ID,
			callerAgentId: 'master',
			sessionId: session.id,
		})

		const parsed = parseAgentId(output.taskId)
		expect(parsed?.prefix).toBe(EXPLORER_AGENT_ID)
		expect(master.subagents[output.taskId]).toMatchObject({
			id: output.taskId,
			type: EXPLORER_AGENT_ID,
		})
		expect(output).toMatchObject({
			subagentType: EXPLORER_AGENT_ID,
			status: 'dispatched',
		})
	})

	it('rejects non-dispatchable agent types', async () => {
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
			} as never,
			{} as never,
			{} as never,
		)

		await expect(
			manager.dispatchTask({
				prompt: 'Inspect the vault',
				subagentType: MASTER_AGENT_ID,
				callerAgentId: MASTER_AGENT_ID,
				sessionId: session.id,
			}),
		).rejects.toThrow('cannot be dispatched')
		expect(master.subagents).toEqual({})
	})

	it('suspends a cancelled background agent after its current tool step', async () => {
		const master = createEmptyMasterAgent(1)
		const agent: ChatAgentState = {
			...createEmptyMasterAgent(2),
			id: 'child',
			type: 'subagent',
			status: 'running',
			timeline: [
				{
					id: 'request',
					role: 'user',
					parts: [{ type: 'text', text: 'work' }],
				},
			],
		}
		master.subagents.child = agent
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
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
			{} as never,
			vi.fn(),
			{} as never,
			{} as never,
			{ runTurn: vi.fn() } as never,
		)
		const runTurn = vi
			.spyOn(
				(
					manager as never as {
						agentRunner: { runTurn(options: unknown): unknown }
					}
				).agentRunner,
				'runTurn',
			)
			.mockResolvedValue({ status: 'cancelled' } as never)

		const resultPromise = (
			manager as never as {
				runBackgroundTaskLoop(
					agent: ChatAgentState,
					session: ChatSession,
					provider: unknown,
					model: unknown,
				): Promise<unknown>
			}
		).runBackgroundTaskLoop(agent, session, {} as never, {} as never)
		const options = runTurn.mock.calls[0][0] as {
			shouldSuspendAfterToolStep: () => boolean
		}
		agent.status = 'cancelled'

		expect(options.shouldSuspendAfterToolStep()).toBe(true)
		await resultPromise
	})
})
