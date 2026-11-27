import type { LanguageModelUsage } from 'ai'
import { parse as parseAgentId } from 'id-agent'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createAIRuntimeHarness,
	createTestProvider,
} from '@test/harness/ai-runtime-harness'
import { createDeferred, flushUntil } from '@test/harness/async-scheduler'
import { EXPLORER_AGENT_ID, MASTER_AGENT_ID } from '~/ai/chat/agents/registry'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import {
	createMasterTurnScheduler,
	type TaskOrigin,
} from '~/ai/chat/runtime/master-turn-scheduler'
import { normalizeRehydratedExecution } from '~/ai/chat/session/rehydration-execution'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
import type { ToolCallRepeatState } from '~/ai/core/tool-call-repeat'
import type { AIProviderConfig } from '~/ai/core/types'
import { BASH_TMP_MOUNT_POINT } from '~/ai/tools/bash/mount-points'

const writeTaskResult = vi.hoisted(() => vi.fn(async () => undefined))
const generateText = vi.hoisted(() => vi.fn())
const NEUTRAL_TEXT = 'Hello 你好 🌿'

vi.mock('~/ai/tools/bash/tmp-fs', () => ({ writeBashTmpText: writeTaskResult }))
vi.mock('ai', async (importOriginal) => ({
	...(await importOriginal<typeof import('ai')>()),
	generateText,
}))
vi.mock('~/ai/core/runtime', () => ({
	assertProviderUsable: () => undefined,
	prepareMessagesForModel: (
		_provider: unknown,
		_model: string,
		messages: unknown,
	) => messages,
	resolveLanguageModel: () => ({ model: {} }),
}))

const testOrigin = (turnId = 'T1'): TaskOrigin => ({
	turnId,
	signal: new AbortController().signal,
})

const makeUsage = (inputTokens: number): LanguageModelUsage => ({
	inputTokens,
	outputTokens: 0,
	totalTokens: inputTokens,
	inputTokenDetails: {
		noCacheTokens: inputTokens,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	},
	outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
})

const makeAgent = (
	id: string,
	overrides: Partial<ChatAgentState> = {},
): ChatAgentState => ({
	...createEmptyMasterAgent(2),
	id,
	type: 'subagent',
	status: 'running',
	...overrides,
})

describe('TaskManager parent notifications and execution lifecycle', () => {
	beforeEach(() => {
		writeTaskResult.mockReset()
		writeTaskResult.mockResolvedValue(undefined)
		generateText.mockReset()
	})

	it('persists the result before notifying the direct parent', async () => {
		const events: string[] = []
		writeTaskResult.mockImplementationOnce(async () => {
			events.push('persist-result')
		})
		const parent = makeAgent('parent')
		const child = makeAgent('child')
		parent.subagents.child = child
		const f = createAIRuntimeHarness({
			onPersistSession: async () => {
				events.push(
					parent.pendingInputs.length > 0
						? 'persist-parent-inbox'
						: 'persist-child-settled',
				)
			},
		})
		f.master.subagents.parent = parent

		await f.manager.finishAgentAsCompleted(
			f.session,
			child,
			'done',
			testOrigin(),
		)

		expect(events).toEqual([
			'persist-result',
			'persist-child-settled',
			'persist-parent-inbox',
		])
		expect(writeTaskResult).toHaveBeenCalledWith(
			f.app,
			`${BASH_TMP_MOUNT_POINT}/session/tasks/child.txt`,
			'done',
		)
		expect(f.master.pendingInputs).toEqual([])
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
		const persistGate = createDeferred<void>()
		let isPersistCurrent: (() => boolean) | undefined
		const controller = new AbortController()
		const f = createAIRuntimeHarness({
			onPersistSession: (_session, isCurrent) => {
				isPersistCurrent = isCurrent
				return persistGate.promise
			},
		})
		const child = makeAgent('completed-child')
		f.master.subagents[child.id] = child

		const completion = f.manager.finishAgentAsCompleted(
			f.session,
			child,
			NEUTRAL_TEXT,
			{ turnId: 'T1', signal: controller.signal },
		)
		await flushUntil(() => f.persistSession.mock.calls.length === 1)
		controller.abort()

		expect(isPersistCurrent?.()).toBe(true)
		persistGate.resolve()
		await completion

		expect(child.status).toBe('completed')
		expect(f.masterHandler).not.toHaveBeenCalled()
	})

	it('persists the master inbox before enqueuing its continuation', async () => {
		const events: string[] = []
		const f = createAIRuntimeHarness({
			onPersistSession: async () => {
				events.push(`persist:${f.master.pendingInputs.length}`)
			},
			onMasterWake: () => {
				events.push('wake-master')
				return true
			},
		})
		const child = makeAgent('master-child')
		f.master.subagents[child.id] = child

		await f.manager.finishAgentAsCompleted(
			f.session,
			child,
			NEUTRAL_TEXT,
			testOrigin(),
		)

		expect(events).toEqual(['persist:0', 'persist:1', 'wake-master'])
		expect(f.persistSession).toHaveBeenCalledTimes(2)
		expect(f.masterHandler).toHaveBeenCalledTimes(1)
	})

	it.each([0, 1, 3])(
		'rebuilds an unconsumed task continuation at depth %s after rehydration',
		(depth) => {
			const f = createAIRuntimeHarness()
			let parent = f.master
			for (let level = 0; level < depth; level += 1) {
				const ancestor = makeAgent(`探索 Explorer 🌿 ${level}`, {
					type: EXPLORER_AGENT_ID,
					status: 'idle',
				})
				parent.subagents[ancestor.id] = ancestor
				parent = ancestor
			}
			const child = makeAgent('记忆 Memory 🌿', {
				type: EXPLORER_AGENT_ID,
				status: 'completed',
				resultPath: `${BASH_TMP_MOUNT_POINT}/session/tasks/记忆 Memory 🌿.txt`,
			})
			parent.subagents[child.id] = child
			if (depth > 0) {
				parent.pendingInputs.push({
					id: '结果 Result 🌿',
					role: 'user',
					parts: [
						{
							type: 'data-system-notification',
							data: {
								kind: 'task-result-ready',
								taskId: child.id,
								resultPath: child.resultPath!,
							},
						},
					],
				})
			}

			normalizeRehydratedExecution(f.session)
			expect(f.manager.restoreMasterTaskContinuations(f.session)).toBe(true)

			expect(f.masterHandler).not.toHaveBeenCalled()
			expect(parent.pendingInputs).toHaveLength(1)
			expect(parent.pendingInputs[0].parts[0]).toMatchObject({
				type: 'data-system-notification',
				data: { taskId: child.id, resultPath: child.resultPath },
			})
			if (depth > 0) expect(parent.status).toBe('cancelled')

			expect(f.manager.restoreMasterTaskContinuations(f.session)).toBe(false)
			expect(parent.pendingInputs).toHaveLength(1)
			parent.timeline.push(...parent.pendingInputs.splice(0))
			normalizeRehydratedExecution(f.session)
			expect(f.manager.restoreMasterTaskContinuations(f.session)).toBe(false)
			expect(parent.pendingInputs).toEqual([])
			expect(f.masterHandler).not.toHaveBeenCalled()
		},
	)

	it('does not settle or notify when persisting the result fails', async () => {
		writeTaskResult.mockRejectedValueOnce(new Error('disk full'))
		const f = createAIRuntimeHarness()
		const child = makeAgent('child')
		f.master.subagents.child = child

		await expect(
			f.manager.finishAgentAsCompleted(f.session, child, 'done', testOrigin()),
		).rejects.toThrow('disk full')

		expect(child.status).toBe('running')
		expect(f.master.pendingInputs).toEqual([])
		expect(f.persistSession).not.toHaveBeenCalled()
	})

	it('settles a child when direct parent delivery cannot be staged', async () => {
		let callCount = 0
		const f = createAIRuntimeHarness({
			onPersistSession: async () => {
				callCount += 1
				if (callCount === 2) throw new Error('neutral parent delivery failure')
			},
		})
		const parent = makeAgent('parent')
		const child = makeAgent('child')
		parent.subagents[child.id] = child
		f.master.subagents[parent.id] = parent

		await expect(
			f.manager.finishAgentAsCompleted(
				f.session,
				child,
				NEUTRAL_TEXT,
				testOrigin(),
			),
		).rejects.toThrow('neutral parent delivery failure')

		expect(child.status).toBe('completed')
		expect(parent.pendingInputs).toEqual([])
	})

	it('does not deliver an orphaned child result to the master', async () => {
		const f = createAIRuntimeHarness()
		const child = makeAgent('orphaned-child')

		await expect(
			f.manager.finishAgentAsCompleted(
				f.session,
				child,
				NEUTRAL_TEXT,
				testOrigin(),
			),
		).rejects.toThrow('Task initiator is unavailable')

		expect(child.status).toBe('completed')
		expect(f.masterHandler).not.toHaveBeenCalled()
	})

	it.each([
		'origin is aborted',
		'session is replaced',
		'parent becomes terminal',
	])(
		'retains a durable nested continuation without reviving execution when persistence resumes after the %s',
		async (staleCondition) => {
			const deliveryPersist = createDeferred<void>()
			let callCount = 0
			const controller = new AbortController()
			const f = createAIRuntimeHarness({
				onPersistSession: () => {
					callCount += 1
					return callCount === 2 ? deliveryPersist.promise : Promise.resolve()
				},
			})
			const parent = makeAgent('parent')
			const child = makeAgent('child')
			parent.subagents[child.id] = child
			f.master.subagents[parent.id] = parent

			const completion = f.manager.finishAgentAsCompleted(
				f.session,
				child,
				NEUTRAL_TEXT,
				{ turnId: 'T1', signal: controller.signal },
			)
			await flushUntil(() => f.persistSession.mock.calls.length === 2)

			if (staleCondition === 'origin is aborted') controller.abort()
			if (staleCondition === 'session is replaced') {
				f.state.loadedSessions.set(f.session.id, {
					...f.session,
					subagents: { master: createEmptyMasterAgent(4) },
				})
			}
			if (staleCondition === 'parent becomes terminal') {
				parent.status = 'cancelled'
			}
			deliveryPersist.resolve()
			await completion

			expect(child.status).toBe('completed')
			expect(parent.pendingInputs).toHaveLength(1)
		},
	)

	it('completes only a running child', async () => {
		const f = createAIRuntimeHarness()
		const child = makeAgent('idle-child', { status: 'idle' })
		f.master.subagents[child.id] = child

		await f.manager.finishAgentAsCompleted(
			f.session,
			child,
			NEUTRAL_TEXT,
			testOrigin(),
		)

		expect(child.status).toBe('idle')
		expect(writeTaskResult).not.toHaveBeenCalled()
	})

	it('dispatches a typed subagent with an id-agent task id', async () => {
		const f = createAIRuntimeHarness({
			model: { providerId: 'provider', modelId: 'model' },
		})
		vi.spyOn(f.manager, 'runAgent').mockResolvedValue(undefined)

		const output = await f.manager.dispatchTask(
			{
				prompt: 'Inspect the vault 检查库内容 🌿',
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: MASTER_AGENT_ID,
				sessionId: f.session.id,
			},
			testOrigin(),
		)

		expect(parseAgentId(output.taskId)?.prefix).toBe(EXPLORER_AGENT_ID)
		expect(f.master.subagents[output.taskId]).toMatchObject({
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
		const configuredModel = {
			providerId: 'configured-provider',
			modelId: 'configured-model',
		}
		const f = createAIRuntimeHarness({
			sessionId: 'neutral-session',
			model: { providerId: 'caller-provider', modelId: 'caller-model' },
			providers: {
				'configured-provider': createTestProvider(
					'configured-provider',
					'configured-model',
				),
			},
			subagentModelSelection: () => ({ ...configuredModel }),
		})
		vi.spyOn(f.manager, 'runAgent').mockResolvedValue(undefined)

		const task = await f.manager.dispatchTask(
			{
				prompt: '调查中性内容 🌿',
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: MASTER_AGENT_ID,
				sessionId: f.session.id,
			},
			testOrigin(),
		)
		configuredModel.modelId = 'changed-after-dispatch'

		expect(f.master.subagents[task.taskId].model).toEqual({
			providerId: 'configured-provider',
			modelId: 'configured-model',
		})
	})

	it.each<{ name: string; providers: Record<string, AIProviderConfig> }>([
		{ name: 'deleted provider', providers: {} },
		{
			name: 'removed model',
			providers: {
				'configured-provider': createTestProvider(
					'configured-provider',
					'other-model',
				),
			},
		},
	])(
		'falls back to the caller model after a $name subagent configuration',
		async ({ providers }) => {
			const f = createAIRuntimeHarness({
				sessionId: 'neutral-session',
				model: { providerId: 'caller-provider', modelId: 'caller-model' },
				providers,
				subagentModelSelection: () => ({
					providerId: 'configured-provider',
					modelId: 'configured-model',
				}),
			})
			vi.spyOn(f.manager, 'runAgent').mockResolvedValue(undefined)

			const task = await f.manager.dispatchTask(
				{
					prompt: 'Review neutral notes 复核中性笔记 🌿',
					subagentType: EXPLORER_AGENT_ID,
					callerAgentId: MASTER_AGENT_ID,
					sessionId: f.session.id,
				},
				testOrigin(),
			)

			expect(f.master.subagents[task.taskId].model).toEqual(f.session.model)
		},
	)

	it('settles an unavailable configured model and notifies its parent', async () => {
		const f = createAIRuntimeHarness({
			sessionId: 'neutral-session',
			providers: {},
		})
		const child = makeAgent('neutral-child', {
			type: EXPLORER_AGENT_ID,
			model: { providerId: 'missing-provider', modelId: 'missing-model' },
		})
		f.master.subagents[child.id] = child

		await f.manager.runAgent(f.session, child, testOrigin())

		expect(child.status).toBe('failed')
		expect(child.resultPath).toBe(
			`${BASH_TMP_MOUNT_POINT}/${f.session.id}/tasks/${child.id}.txt`,
		)
		expect(writeTaskResult).toHaveBeenCalledWith(
			f.app,
			child.resultPath,
			expect.stringContaining('Select a provider'),
		)
		expect(f.masterHandler).toHaveBeenCalledWith(
			f.session.id,
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
		const controller = new AbortController()
		const origin: TaskOrigin = { turnId: 'T1', signal: controller.signal }
		const f = createAIRuntimeHarness({
			model: { providerId: 'provider', modelId: 'model' },
		})
		f.state.runtimeBySessionId.set(f.session.id, {
			runState: 'thinking',
			draft: { text: '', userContext: [] },
			scheduler: {
				...createMasterTurnScheduler(),
				active: {
					inputs: [
						{
							turnId: 'T1',
							kind: 'user-submission',
							submission: { text: NEUTRAL_TEXT, userContext: [] },
						},
					],
					abortController: controller,
				},
			},
		})
		vi.spyOn(f.manager, 'runAgent').mockResolvedValue(undefined)

		const first = await f.manager.dispatchTask(
			{
				prompt: NEUTRAL_TEXT,
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: MASTER_AGENT_ID,
				sessionId: f.session.id,
			},
			origin,
		)
		const firstAgent = f.master.subagents[first.taskId]
		const second = await f.manager.dispatchTask(
			{
				prompt: NEUTRAL_TEXT,
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: first.taskId,
				sessionId: f.session.id,
			},
			origin,
		)

		await f.manager.finishAgentAsCompleted(
			f.session,
			firstAgent.subagents[second.taskId],
			NEUTRAL_TEXT,
			origin,
		)
		expect(firstAgent.pendingInputs).toHaveLength(1)
		await f.manager.finishAgentAsCompleted(
			f.session,
			firstAgent,
			NEUTRAL_TEXT,
			origin,
		)

		expect(f.masterHandler).toHaveBeenCalledTimes(1)
		expect(f.masterHandler.mock.calls[0]?.[2]).toEqual({
			turnId: 'T1',
			signal: controller.signal,
		})
		expect(f.master.pendingInputs).toHaveLength(1)
	})

	it('cancelling T1 leaves T0 child compaction running', async () => {
		const f = createAIRuntimeHarness({
			model: { providerId: 'provider', modelId: 'model' },
		})
		const cancelSpy = vi.spyOn(f.coordinator, 'cancel')
		vi.spyOn(f.manager, 'runAgent').mockResolvedValue(undefined)

		const t0 = await f.manager.dispatchTask(
			{
				prompt: NEUTRAL_TEXT,
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: MASTER_AGENT_ID,
				sessionId: f.session.id,
			},
			testOrigin('T0'),
		)
		const t1 = await f.manager.dispatchTask(
			{
				prompt: NEUTRAL_TEXT,
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: MASTER_AGENT_ID,
				sessionId: f.session.id,
			},
			testOrigin('T1'),
		)

		f.manager.cancelAllNonTerminalAgents(f.session, 'T1')

		expect(f.master.subagents[t0.taskId].status).toBe('running')
		expect(f.master.subagents[t1.taskId].status).toBe('cancelled')
		expect(cancelSpy).toHaveBeenCalledWith(f.session.id, t1.taskId)
		expect(cancelSpy).not.toHaveBeenCalledWith(f.session.id, t0.taskId)
	})

	it('does not revive a task completion cancelled while its result is being written', async () => {
		const writeGate = createDeferred<undefined>()
		writeTaskResult.mockImplementationOnce(() => writeGate.promise)
		const f = createAIRuntimeHarness()
		const child = makeAgent('child', { type: EXPLORER_AGENT_ID })
		f.master.subagents[child.id] = child

		const completion = f.manager.finishAgentAsCompleted(
			f.session,
			child,
			NEUTRAL_TEXT,
			testOrigin(),
		)
		await flushUntil(() => writeTaskResult.mock.calls.length === 1)
		child.status = 'cancelled'
		child.finishedAt = Date.now()
		writeGate.resolve(undefined)
		await completion

		expect(child.status).toBe('cancelled')
		expect(f.masterHandler).not.toHaveBeenCalled()
	})

	it('discards a stale task completion after its session is rehydrated', async () => {
		const writeGate = createDeferred<undefined>()
		writeTaskResult.mockImplementationOnce(() => writeGate.promise)
		const f = createAIRuntimeHarness()
		const child = makeAgent('child', { type: EXPLORER_AGENT_ID })
		f.master.subagents[child.id] = child

		const completion = f.manager.finishAgentAsCompleted(
			f.session,
			child,
			NEUTRAL_TEXT,
			testOrigin(),
		)
		await flushUntil(() => writeTaskResult.mock.calls.length === 1)
		f.state.loadedSessions.set(f.session.id, {
			...f.session,
			subagents: { master: createEmptyMasterAgent(3) },
		})
		writeGate.resolve(undefined)
		await completion

		expect(child.status).toBe('running')
		expect(f.persistSession).not.toHaveBeenCalled()
		expect(f.masterHandler).not.toHaveBeenCalled()
	})

	it('does not deliver a settled task after its session is rehydrated', async () => {
		const persistGate = createDeferred<void>()
		let isPersistCurrent: (() => boolean) | undefined
		const f = createAIRuntimeHarness({
			onPersistSession: (_session, isCurrent) => {
				isPersistCurrent = isCurrent
				return persistGate.promise
			},
		})
		const child = makeAgent('child', { type: EXPLORER_AGENT_ID })
		f.master.subagents[child.id] = child

		const completion = f.manager.finishAgentAsCompleted(
			f.session,
			child,
			NEUTRAL_TEXT,
			testOrigin(),
		)
		await flushUntil(() => f.persistSession.mock.calls.length === 1)
		f.state.loadedSessions.set(f.session.id, {
			...f.session,
			subagents: { master: createEmptyMasterAgent(3) },
		})
		expect(isPersistCurrent?.()).toBe(false)
		persistGate.resolve()
		await completion

		expect(f.masterHandler).not.toHaveBeenCalled()
		expect(f.master.pendingInputs).toEqual([])
	})

	it('fences master delivery after the origin turn is aborted', async () => {
		const controller = new AbortController()
		const f = createAIRuntimeHarness({
			model: { providerId: 'provider', modelId: 'model' },
		})
		f.state.runtimeBySessionId.set(f.session.id, {
			runState: 'thinking',
			draft: { text: '', userContext: [] },
			scheduler: {
				...createMasterTurnScheduler(),
				active: {
					inputs: [
						{
							turnId: 'T1',
							kind: 'user-submission',
							submission: { text: NEUTRAL_TEXT, userContext: [] },
						},
					],
					abortController: controller,
				},
			},
		})
		vi.spyOn(f.manager, 'runAgent').mockResolvedValue(undefined)

		const output = await f.manager.dispatchTask(
			{
				prompt: NEUTRAL_TEXT,
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: MASTER_AGENT_ID,
				sessionId: f.session.id,
			},
			{ turnId: 'T1', signal: controller.signal },
		)
		controller.abort()
		await f.manager.finishAgentAsCompleted(
			f.session,
			f.master.subagents[output.taskId],
			NEUTRAL_TEXT,
			{ turnId: 'T1', signal: controller.signal },
		)

		expect(f.masterHandler).not.toHaveBeenCalled()
		expect(f.master.pendingInputs).toEqual([])
	})

	it('rejects non-dispatchable agent types, including a disabled explorer', async () => {
		const f = createAIRuntimeHarness({
			model: { providerId: 'provider', modelId: 'model' },
			enableExplorer: false,
		})

		for (const subagentType of [MASTER_AGENT_ID, EXPLORER_AGENT_ID]) {
			await expect(
				f.manager.dispatchTask(
					{
						prompt: 'Inspect neutral notes 检查中性笔记 🌿',
						subagentType,
						callerAgentId: MASTER_AGENT_ID,
						sessionId: f.session.id,
					},
					testOrigin(),
				),
			).rejects.toThrow('cannot be dispatched')
		}
		expect(f.master.subagents).toEqual({})
	})

	it('carries tool-call continuation across a compaction resume', async () => {
		const continuation: ToolCallRepeatState = {
			consecutiveCount: 2,
			isRepeatedTooManyTimes: false,
		}
		let turnIndex = 0
		const f = createAIRuntimeHarness({
			sessionId: 'neutral-session',
			onRunTurn: async () => {
				turnIndex += 1
				return turnIndex === 1
					? { status: 'needs-compaction', continuation }
					: { status: 'completed', text: NEUTRAL_TEXT }
			},
		})
		const agent = makeAgent('neutral-child', {
			model: { providerId: 'neutral-provider', modelId: 'neutral-model' },
			timeline: [
				{
					id: 'neutral-request',
					role: 'user',
					metadata: { createdAt: 1 },
					parts: [{ type: 'text', text: NEUTRAL_TEXT }],
				},
			],
		})
		f.master.subagents[agent.id] = agent

		await f.manager.runAgent(f.session, agent, testOrigin())

		expect(f.runTurn.mock.calls[1]?.[0].continuation).toBe(continuation)
	})

	it('settles after one failed hard-pressure summary instead of retrying', async () => {
		generateText.mockResolvedValue({ text: ' \n\t ' })
		const f = createAIRuntimeHarness({
			sessionId: 'neutral-session',
			providers: {
				'neutral-provider': createTestProvider(
					'neutral-provider',
					'neutral-model',
					{ context: 100_000, output: 10_000 },
				),
			},
		})
		const agent = makeAgent('neutral-child', {
			model: { providerId: 'neutral-provider', modelId: 'neutral-model' },
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
					metadata: { createdAt: 2, llm: { usage: makeUsage(86_000) } },
					parts: [{ type: 'text', text: NEUTRAL_TEXT }],
				},
				{
					id: 'neutral-current-user',
					role: 'user',
					metadata: { createdAt: 3 },
					parts: [{ type: 'text', text: NEUTRAL_TEXT }],
				},
			],
		})
		f.master.subagents[agent.id] = agent

		await f.manager.runAgent(f.session, agent, testOrigin())

		expect(generateText).toHaveBeenCalledTimes(1)
		expect(f.runTurn).not.toHaveBeenCalled()
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
		const provider = createTestProvider('neutral-provider', 'neutral-model', {
			context: 100_000,
			output: 10_000,
		})
		const f = createAIRuntimeHarness({
			sessionId: 'neutral-session',
			providers: { [provider.id]: provider },
		})
		const agent = makeAgent('neutral-child', {
			timeline: [
				{
					...message('neutral-old-user', 'user', 1),
					parts: [{ type: 'text', text: NEUTRAL_TEXT.repeat(10_000) }],
				},
				message('neutral-old-assistant', 'assistant', 2),
				message('neutral-current-user', 'user', 3),
			],
		})
		agent.timeline[1].metadata!.llm = { usage: makeUsage(82_000) }
		f.master.subagents[agent.id] = agent

		expect(
			f.coordinator.inspect({
				session: f.session,
				agent,
				provider,
				model: provider.models['neutral-model'],
				revision: 'neutral-revision',
				resolveSummaryContext: async () => ({}),
				isCancelled: () => false,
				isCurrent: () => true,
			}),
		).toBe('ready')
		await flushUntil(() => signal !== undefined)

		await f.manager.finishAgentAsCompleted(
			f.session,
			agent,
			NEUTRAL_TEXT,
			testOrigin(),
		)

		expect(signal!.aborted).toBe(true)
		expect(generateText).toHaveBeenCalledTimes(1)
	})
})
