import type { ChatSession } from '~/ai/chat/domain'
import { MessageFactory } from '~/ai/chat/messages/message-factory'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import { describe, expect, it, vi } from 'vitest'
import { AgentEventProjector } from '~/ai/chat/runtime/agent-event-projector'
import type { SessionRuntimeState } from '~/ai/chat/runtime/chat-state'

describe('AgentEventProjector', () => {
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
			stopRequested: false,
		} as SessionRuntimeState
		const persistSession = vi.fn(async () => undefined)
		const messageFactory = new MessageFactory(
			{ app: {} } as never,
			{} as never,
			vi.fn(),
		)
		const projector = new AgentEventProjector({
			session,
			agent,
			runtime,
			store: { persistSession } as never,
			messageFactory,
			notify: vi.fn(),
			assistantMeta: { providerId: 'provider', modelId: 'model' },
			isDeleted: () => false,
			isCancelled: () => false,
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
})
