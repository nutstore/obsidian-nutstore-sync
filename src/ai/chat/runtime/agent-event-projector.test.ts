import type { ChatSession } from '~/ai/chat/domain'
import { MessageFactory } from '~/ai/chat/messages/message-factory'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import { describe, expect, it, vi } from 'vitest'
import { AgentEventProjector } from '~/ai/chat/runtime/agent-event-projector'
import type { SessionRuntimeState } from '~/ai/chat/runtime/chat-state'
import { createMasterTurnScheduler } from '~/ai/chat/runtime/master-turn-scheduler'

describe('AgentEventProjector', () => {
	it('projects a running tool immediately and records its exact duration', async () => {
		const agent = createEmptyMasterAgent(1)
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master: agent },
		}
		const runtime = {
			runState: 'thinking',
			draft: { text: '', userContext: [] },
			scheduler: createMasterTurnScheduler(),
		} as SessionRuntimeState
		const notify = vi.fn()
		const projector = new AgentEventProjector({
			session,
			agent,
			runtime,
			store: { persistSession: vi.fn(async () => undefined) } as never,
			messageFactory: new MessageFactory({ app: {} } as never, vi.fn()),
			notify,
			assistantMeta: { providerId: 'provider', modelId: 'model' },
			isTurnAlive: () => true,
		})

		await projector.project({
			type: 'tool-execution-start',
			toolCall: {
				type: 'tool-call',
				toolCallId: 'call-1',
				toolName: 'lookup',
				input: { query: 'status' },
			} as never,
		})

		expect(agent.timeline[0].parts[0]).toMatchObject({
			type: 'dynamic-tool',
			state: 'input-available',
			toolCallId: 'call-1',
		})
		expect(runtime.runState).toBe('waiting_for_tools')
		expect(agent.toolTimings['call-1'].finishedAt).toBeUndefined()

		await projector.project({
			type: 'tool-execution-end',
			toolCallId: 'call-1',
			durationMs: 125,
			toolOutput: { type: 'tool-result', output: 'ok' },
		})

		const timing = agent.toolTimings['call-1']
		expect(timing.finishedAt! - timing.startedAt).toBe(125)
		expect(agent.timeline[0].parts[0]).toMatchObject({
			state: 'output-available',
			output: 'ok',
		})

		await projector.project({
			type: 'assistant-step',
			response: {
				message: {
					role: 'assistant',
					content: [
						{
							type: 'tool-call',
							toolCallId: 'call-1',
							toolName: 'lookup',
							input: { query: 'status' },
						},
					],
				},
				meta: { modelId: 'provider-model' },
			},
		})

		expect(agent.timeline[0].parts[0]).toMatchObject({
			state: 'output-available',
			output: 'ok',
		})
		expect(notify).toHaveBeenCalledTimes(3)
	})

	it('merges tool results into the assistant UI message', async () => {
		const agent = createEmptyMasterAgent(1)
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master: agent },
		}
		const runtime = {
			runState: 'thinking',
			draft: { text: '', userContext: [] },
			scheduler: createMasterTurnScheduler(),
		} as SessionRuntimeState
		const persistSession = vi.fn(async () => undefined)
		const messageFactory = new MessageFactory({ app: {} } as never, vi.fn())
		const projector = new AgentEventProjector({
			session,
			agent,
			runtime,
			store: { persistSession } as never,
			messageFactory,
			notify: vi.fn(),
			assistantMeta: { providerId: 'provider', modelId: 'model' },
			isTurnAlive: () => true,
		})
		await projector.project({
			type: 'assistant-step',
			response: {
				message: {
					role: 'assistant',
					content: [
						{
							type: 'tool-call',
							toolCallId: 'call-1',
							toolName: 'lookup',
							input: {},
						},
					],
				},
				meta: { modelId: 'provider-model' },
			},
		})
		await projector.project({
			type: 'tool-results',
			outcomes: [
				{
					type: 'tool-result',
					toolCallId: 'call-1',
					toolName: 'lookup',
					input: {},
					output: 'ok',
					dynamic: true,
				},
			],
			metadata: new Map([
				[
					'call-1',
					{
						todos: [{ content: 'todo', status: 'pending', priority: 'medium' }],
					},
				],
			]),
		})
		expect(agent.timeline).toHaveLength(1)
		expect(agent.timeline[0].parts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'dynamic-tool',
					state: 'output-available',
					output: 'ok',
				}),
				expect.objectContaining({ type: 'data-todos' }),
			]),
		)
		expect(runtime.runState).toBe('waiting_for_tools')
		expect(persistSession).toHaveBeenCalledTimes(2)
	})

	it('rejects events after the turn loses ownership', async () => {
		const agent = createEmptyMasterAgent(1)
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master: agent },
		}
		let alive = true
		const projector = new AgentEventProjector({
			session,
			agent,
			store: { persistSession: vi.fn(async () => undefined) } as never,
			messageFactory: new MessageFactory({ app: {} } as never, vi.fn()),
			notify: vi.fn(),
			assistantMeta: { providerId: 'provider', modelId: 'model' },
			isTurnAlive: () => alive,
		})

		alive = false
		await projector.project({ type: 'text-delta', delta: 'Hello 你好 🌿' })
		await projector.project({
			type: 'tool-execution-start',
			toolCall: {
				type: 'tool-call',
				toolCallId: 'late-call',
				toolName: 'lookup',
				input: {},
			} as never,
		})

		expect(agent.timeline).toEqual([])
		expect(agent.toolTimings).toEqual({})
	})
})
