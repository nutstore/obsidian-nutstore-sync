import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAgentDefinition } from '~/ai/chat/agents/registry'
import { getSessionSubagents } from '~/ai/chat/domain'
import type { ChatSession } from '~/ai/chat/domain'
import {
	createEmptyMasterAgent,
	consumePendingInputs,
	hasPendingInputs,
	uiMessagesToModelMessages,
} from '~/ai/chat/messages/ui-message'
import type { AgentTurnResult } from './agent-runner'
import { TaskManager } from './task-manager'
import type { AgentAddress } from '~/ai/tools/agent-communication'
import type { ChatAgentState } from '~/ai/chat/types'
import { normalizeRehydratedExecution } from '~/ai/chat/session/rehydration-execution'

const writeResult = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('~/ai/core/runtime', () => ({
	prepareMessagesForModel: (
		_provider: unknown,
		_model: unknown,
		messages: unknown,
	) => messages,
	resolveLanguageModel: () => ({ model: {} }),
}))
vi.mock('~/ai/tools/bash/tmp-fs', () => ({ writeBashTmpText: writeResult }))
const TEXT = '归纳主题 / Summarize themes 🌿'
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { resolve, promise }
}
function harness() {
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
	}
	const persistSession = vi.fn(async () => {})
	const turns = new Map<string, ReturnType<typeof deferred<AgentTurnResult>>>()
	const runTurn = vi.fn(({ agent }: { agent: ChatAgentState }) => {
		consumePendingInputs(agent)
		const turn = deferred<AgentTurnResult>()
		turns.set(agent.id, turn)
		return turn.promise
	})
	const manager = new TaskManager(
		{} as never,
		async () => {},
		state as never,
		{
			getProviderByIdOrThrow: () => ({ id: 'provider' }),
			getModelByIdsOrThrow: () => ({ id: 'model' }),
		} as never,
		{ persistSession } as never,
		vi.fn(),
		{
			getAgentDefinition: (type: string) =>
				getAgentDefinition(type, {
					fullAccess: false,
					subagents: { explorer: { enabled: true } },
				}),
			getSubagentModelSelection: () => undefined,
		} as never,
		{} as never,
		{ runTurn } as never,
		{
			inspect: () => 'ready',
			cancel: vi.fn(),
			shouldSuspendAtSafePoint: () => false,
		} as never,
	)
	const masterWake = vi.fn(() => true)
	manager.setMasterAgentInputHandler(masterWake)
	const controller = new AbortController()
	const origin = { turnId: 'turn', signal: controller.signal }
	const address = (agentId = 'master'): AgentAddress => ({
		sessionId: session.id,
		agentId,
		origin,
	})
	const spawn = async (callerAgentId = 'master') => {
		const { taskId } = await manager.dispatchTask(
			{
				sessionId: session.id,
				callerAgentId,
				subagentType: 'explorer',
				prompt: TEXT,
			},
			origin,
		)
		return getSessionSubagents(session).find((agent) => agent.id === taskId)!
	}
	return {
		manager,
		master,
		session,
		state,
		address,
		spawn,
		persistSession,
		turns,
		runTurn,
		controller,
		masterWake,
	}
}
afterEach(() => {
	vi.useRealTimers()
	writeResult.mockClear()
})

describe('session agent communication', () => {
	it('discovers and delivers bidirectionally across siblings and nested agents with explicit identities', async () => {
		const h = harness()
		const left = await h.spawn()
		const right = await h.spawn()
		const nested = await h.spawn(left.id)
		expect(
			h.manager
				.listAgents(h.address())
				.map(({ id, parent }) => ({ id, parent })),
		).toEqual(
			expect.arrayContaining([
				{ id: 'master', parent: undefined },
				{ id: left.id, parent: 'master' },
				{ id: nested.id, parent: left.id },
				{ id: right.id, parent: 'master' },
			]),
		)
		for (const [from, to] of [
			['master', left.id],
			[left.id, 'master'],
			[left.id, right.id],
			[nested.id, right.id],
			[right.id, nested.id],
		]) {
			await h.manager.sendMessage(h.address(from), to, TEXT)
		}
		expect(h.masterWake).not.toHaveBeenCalled()
		const converted = await uiMessagesToModelMessages(right.pendingInputs)
		expect(JSON.stringify(converted)).toContain('AgentInformation')
		expect(JSON.stringify(converted)).toContain(nested.id)
		expect(JSON.stringify(converted)).toContain(TEXT)
		expect(right.pendingInputs).toHaveLength(2)
		consumePendingInputs(right)
		expect(consumePendingInputs(right)).toBe(false)
	})

	it('rejects missing, cross-session, self, blank and master follow-up targets', async () => {
		const h = harness()
		const child = await h.spawn()
		for (const [target, message] of [
			['missing', TEXT],
			['master', TEXT],
			[child.id, ' \n\t'],
		]) {
			await expect(
				h.manager.sendMessage(h.address(), target, message),
			).rejects.toThrow()
		}
		await expect(
			h.manager.sendMessage(h.address(child.id), 'master', TEXT, true),
		).rejects.toThrow()
		await expect(
			h.manager.sendMessage(
				{ ...h.address(), sessionId: 'other-session' },
				child.id,
				TEXT,
			),
		).rejects.toThrow()
	})

	it.each(['completed', 'failed', 'cancelled'] as const)(
		'retains ordinary mail after %s and explicitly reuses context and model for another round',
		async (status) => {
			const h = harness()
			const child = await h.spawn()
			await vi.waitFor(() => expect(h.turns.has(child.id)).toBe(true))
			h.turns.get(child.id)!.resolve({ status: 'completed', text: TEXT })
			await vi.waitFor(() => expect(child.status).toBe('completed'))
			const first = { ...child.executions![0] }
			child.status = status
			const context = child.timeline.slice()
			const model = child.model
			await h.manager.sendMessage(
				h.address(),
				child.id,
				'补充依据 / Additional evidence 📚',
			)
			expect(child.status).toBe(status)
			expect(child.pendingInputs).toHaveLength(1)
			await h.manager.sendMessage(h.address(), child.id, TEXT, true)
			await vi.waitFor(() => expect(h.runTurn).toHaveBeenCalledTimes(2))
			expect(child.model).toBe(model)
			expect(child.timeline).toEqual(expect.arrayContaining(context))
			expect(
				child.timeline
					.flatMap((message) => message.parts)
					.filter((part) => part.type === 'data-system-notification'),
			).toHaveLength(2)
			h.turns.get(child.id)!.resolve({
				status: 'completed',
				text: '完成归纳 / Themes summarized 🌿',
			})
			await vi.waitFor(() =>
				expect(child.executions?.[1].resultPath).toBeDefined(),
			)
			expect(child.executions?.[1].resultPath).not.toBe(first.resultPath)
			expect(child.executions?.[0]).toEqual(first)
			expect(h.master.pendingInputs).toHaveLength(2)
			h.manager.restoreMasterTaskContinuations(h.session)
			expect(h.master.pendingInputs).toHaveLength(2)
		},
	)

	it('notifies the follow-up initiator instead of the original parent', async () => {
		const h = harness()
		const first = await h.spawn()
		const sibling = await h.spawn()
		await vi.waitFor(() => expect(h.turns.has(first.id)).toBe(true))
		h.turns.get(first.id)!.resolve({ status: 'completed', text: TEXT })
		await vi.waitFor(() => expect(first.status).toBe('completed'))
		await h.manager.sendMessage(h.address(sibling.id), first.id, TEXT, true)
		await vi.waitFor(() => expect(h.runTurn).toHaveBeenCalledTimes(3))
		h.turns.get(first.id)!.resolve({ status: 'completed', text: TEXT })
		await vi.waitFor(() => expect(sibling.pendingInputs).toHaveLength(1))
		expect(first.executions?.[1].initiator).toBe(sibling.id)
		expect(h.master.pendingInputs).toHaveLength(1)
	})

	it('executes follow-up delivered while the previous result is being written', async () => {
		const h = harness()
		const child = await h.spawn()
		await vi.waitFor(() => expect(h.turns.has(child.id)).toBe(true))
		const write = deferred<void>()
		writeResult.mockImplementationOnce(() => write.promise)
		h.turns.get(child.id)!.resolve({ status: 'completed', text: TEXT })
		await vi.waitFor(() => expect(writeResult).toHaveBeenCalledTimes(1))
		expect(child.status).toBe('running')
		const sending = h.manager.sendMessage(h.address(), child.id, TEXT, true)
		await vi.waitFor(() => expect(hasPendingInputs(child)).toBe(true))
		expect(h.runTurn).toHaveBeenCalledTimes(1)
		write.resolve()
		await sending
		await vi.waitFor(() => expect(h.runTurn).toHaveBeenCalledTimes(2))
		expect(child.pendingInputs).toEqual([])
		expect(JSON.stringify(child.timeline)).toContain(TEXT)
		expect(child.executions?.[0].status).toBe('completed')
		h.turns.get(child.id)!.resolve({ status: 'completed', text: TEXT })
		await vi.waitFor(() => expect(h.master.pendingInputs).toHaveLength(2))
		expect(child.executions?.[1].status).toBe('completed')
	})

	it('resumes an idle execution and returns its result to the original initiator', async () => {
		const h = harness()
		const parent = await h.spawn()
		const nested = await h.spawn(parent.id)
		const sibling = await h.spawn()
		await vi.waitFor(() => expect(h.runTurn).toHaveBeenCalledTimes(3))
		const executionId = parent.executionId
		h.turns.get(parent.id)!.resolve({ status: 'completed', text: TEXT })
		await vi.waitFor(() => expect(parent.status).toBe('idle'))
		await h.manager.sendMessage(h.address(sibling.id), parent.id, TEXT, true)
		await vi.waitFor(() => expect(h.runTurn).toHaveBeenCalledTimes(4))
		expect(parent.executionId).toBe(executionId)
		expect(parent.executions).toHaveLength(1)
		expect(parent.executions?.[0].initiator).toBe('master')
		expect(parent.pendingInputs).toEqual([])
		expect(JSON.stringify(parent.timeline)).toContain(TEXT)
		h.turns.get(parent.id)!.resolve({ status: 'completed', text: TEXT })
		await vi.waitFor(() => expect(parent.status).toBe('idle'))
		h.turns.get(nested.id)!.resolve({ status: 'completed', text: TEXT })
		await vi.waitFor(() => expect(h.runTurn).toHaveBeenCalledTimes(5))
		h.turns.get(parent.id)!.resolve({ status: 'completed', text: TEXT })
		await vi.waitFor(() => expect(h.master.pendingInputs).toHaveLength(1))
		expect(parent.executions?.[0].status).toBe('completed')
		expect(sibling.pendingInputs).toEqual([])
	})

	it('does not expose failed or uncommitted deliveries at model boundaries', async () => {
		const h = harness()
		const child = await h.spawn()
		const write = deferred<void>()
		h.persistSession.mockImplementationOnce(() => write.promise)
		const sending = h.manager.sendMessage(h.address(), child.id, TEXT)
		expect(hasPendingInputs(child)).toBe(false)
		expect(consumePendingInputs(child)).toBe(false)
		write.resolve()
		await sending
		expect(consumePendingInputs(child)).toBe(true)
		h.persistSession.mockRejectedValueOnce(
			new Error('存储不可用 / Storage unavailable 🌿'),
		)
		await expect(
			h.manager.sendMessage(h.address(), child.id, TEXT),
		).rejects.toThrow()
		expect(child.pendingInputs).toEqual([])
	})

	it('checks an existing inbox before waiting without consuming the message', async () => {
		const h = harness()
		const child = await h.spawn()
		await h.manager.sendMessage(h.address(), child.id, TEXT)
		expect(await h.manager.waitAgent(h.address(child.id))).toEqual({
			reason: 'message',
		})
		expect(child.pendingInputs).toHaveLength(1)
	})

	it('releases a full concurrency slot and queues a wake without duplicating the suspended loop', async () => {
		const h = harness()
		const children = []
		for (let index = 0; index < 4; index++) children.push(await h.spawn())
		await vi.waitFor(() => expect(h.runTurn).toHaveBeenCalledTimes(3))
		expect(children[3].status).toBe('queued')
		const waiting = h.manager.waitAgent(h.address(children[0].id))
		await vi.waitFor(() => expect(h.runTurn).toHaveBeenCalledTimes(4))
		expect(h.manager.countRunningAgentsForSession(h.session)).toBe(3)
		await h.manager.sendMessage(h.address(children[1].id), children[0].id, TEXT)
		expect(children[0].status).toBe('queued')
		h.turns.get(children[1].id)!.resolve({ status: 'completed', text: TEXT })
		expect(await waiting).toEqual({ reason: 'message' })
		expect(h.manager.countRunningAgentsForSession(h.session)).toBe(3)
		expect(h.runTurn).toHaveBeenCalledTimes(4)
		h.controller.abort()
	})

	it.each(['timeout', 'user-input', 'cancelled'] as const)(
		'wakes with %s and clears its timer',
		async (reason) => {
			vi.useFakeTimers()
			const h = harness()
			const waiting = h.manager.waitAgent(h.address(), 1000)
			if (reason === 'timeout') await vi.advanceTimersByTimeAsync(1000)
			if (reason === 'user-input') h.manager.wakeForUserInput(h.session.id)
			if (reason === 'cancelled') h.controller.abort()
			expect(await waiting).toEqual({ reason })
			expect(vi.getTimerCount()).toBe(0)
		},
	)

	it('cancels a wake queued at capacity and never starts it after cleanup', async () => {
		const h = harness()
		const children = []
		for (let index = 0; index < 4; index++) children.push(await h.spawn())
		const waiting = h.manager.waitAgent(h.address(children[0].id))
		await h.manager.sendMessage(h.address(), children[0].id, TEXT)
		h.manager.cancelAllNonTerminalAgents(h.session)
		h.manager.cleanupSessionAgentTracking(h.session)
		expect(await waiting).toEqual({ reason: 'cancelled' })
		h.manager.startQueuedAgentsForSession(h.session)
		expect(children.every((agent) => agent.status === 'cancelled')).toBe(true)
	})

	it('keeps a sibling initiator idle until its assigned follow-up returns', async () => {
		const h = harness()
		const target = await h.spawn()
		const initiator = await h.spawn()
		await vi.waitFor(() => expect(h.turns.has(target.id)).toBe(true))
		h.turns.get(target.id)!.resolve({ status: 'completed', text: TEXT })
		await vi.waitFor(() => expect(target.status).toBe('completed'))
		await h.manager.sendMessage(h.address(initiator.id), target.id, TEXT, true)
		await vi.waitFor(() => expect(h.runTurn).toHaveBeenCalledTimes(3))
		h.turns.get(initiator.id)!.resolve({ status: 'completed', text: TEXT })
		await vi.waitFor(() => expect(initiator.status).toBe('idle'))
		expect(initiator.resultPath).toBeUndefined()
		h.turns.get(target.id)!.resolve({ status: 'completed', text: TEXT })
		await vi.waitFor(() => expect(h.runTurn).toHaveBeenCalledTimes(4))
		expect(initiator.executions).toHaveLength(1)
		expect(
			initiator.timeline.flatMap((message) => message.parts),
		).toContainEqual(
			expect.objectContaining({
				type: 'data-system-notification',
				data: expect.objectContaining({
					kind: 'task-result-ready',
					sender: target.id,
				}),
			}),
		)
	})

	it('returns for user input already queued before waiting', async () => {
		const h = harness()
		h.manager.setUserInputPendingHandler(() => true)
		expect(await h.manager.waitAgent(h.address())).toEqual({
			reason: 'user-input',
		})
		expect(h.master.status).toBe('idle')
	})

	it('aborts a queued wake immediately even after its message wake was recorded', async () => {
		const h = harness()
		const children = []
		for (let index = 0; index < 4; index++) children.push(await h.spawn())
		const waiting = h.manager.waitAgent(h.address(children[0].id))
		await h.manager.sendMessage(h.address(), children[0].id, TEXT)
		expect(children[0].status).toBe('queued')
		h.controller.abort()
		expect(await waiting).toEqual({ reason: 'cancelled' })
		expect(children[0].status).toBe('cancelled')
	})

	it('does not admit a new execution until its dispatch is durable', async () => {
		const h = harness()
		const write = deferred<void>()
		h.persistSession.mockImplementationOnce(() => write.promise)
		const spawning = h.spawn()
		await vi.waitFor(() =>
			expect(getSessionSubagents(h.session)).toHaveLength(1),
		)
		h.manager.startQueuedAgentsForSession(h.session)
		expect(h.runTurn).not.toHaveBeenCalled()
		write.resolve()
		await spawning
		await vi.waitFor(() => expect(h.runTurn).toHaveBeenCalledTimes(1))
	})

	it('rolls back failed dispatch persistence without leaving a queued execution', async () => {
		const h = harness()
		h.persistSession.mockRejectedValueOnce(
			new Error('存储不可用 / Storage unavailable 🌿'),
		)
		await expect(h.spawn()).rejects.toThrow()
		expect(getSessionSubagents(h.session)).toEqual([])
		expect(h.runTurn).not.toHaveBeenCalled()
	})

	it('deduplicates concurrent settlement attempts for one execution artifact', async () => {
		const h = harness()
		const child = await h.spawn()
		const write = deferred<void>()
		writeResult.mockImplementationOnce(() => write.promise)
		const first = h.manager.finishAgentAsCompleted(
			h.session,
			child,
			TEXT,
			h.address().origin,
		)
		const duplicate = h.manager.finishAgentAsCompleted(
			h.session,
			child,
			TEXT,
			h.address().origin,
		)
		write.resolve()
		await Promise.all([first, duplicate])
		expect(writeResult).toHaveBeenCalledTimes(1)
		expect(h.master.pendingInputs).toHaveLength(1)
	})

	it('rehydrates inboxes and result history without executing, and deduplicates consumed legacy results', async () => {
		const h = harness()
		const child = await h.spawn()
		await h.manager.sendMessage(h.address(), child.id, TEXT, true)
		const restored = JSON.parse(JSON.stringify(h.session)) as ChatSession
		normalizeRehydratedExecution(restored)
		h.state.loadedSessions.set(restored.id, restored)
		h.manager.cleanupSessionAgentTracking(h.session)
		h.manager.restoreMasterTaskContinuations(restored)
		const restoredChild = getSessionSubagents(restored)[0]
		expect(restoredChild.status).toBe('cancelled')
		expect(restoredChild.pendingInputs).toHaveLength(1)
		expect(restoredChild.executions).toHaveLength(1)
		const calls = h.runTurn.mock.calls.length
		h.manager.startQueuedAgentsForSession(restored)
		expect(h.runTurn).toHaveBeenCalledTimes(calls)
		restoredChild.executions = undefined
		restoredChild.executionId = undefined
		restoredChild.resultPath = '/legacy/结果 Result 🌿.txt'
		restored.subagents.master.timeline.push({
			id: 'legacy-notice',
			role: 'user',
			parts: [
				{
					type: 'data-system-notification',
					data: {
						kind: 'task-result-ready',
						taskId: restoredChild.id,
						resultPath: restoredChild.resultPath,
					},
				},
			],
		})
		h.manager.restoreMasterTaskContinuations(restored)
		h.manager.restoreMasterTaskContinuations(restored)
		expect(restoredChild.executions).toHaveLength(1)
		expect(restored.subagents.master.pendingInputs).toEqual([])
	})
})
