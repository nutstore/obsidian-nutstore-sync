import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '~/ai/chat/domain'
import { MessageFactory } from '~/ai/chat/messages/message-factory'
import {
	createEmptyMasterAgent,
	selectContextTimeline,
} from '~/ai/chat/messages/ui-message'
import {
	findRecentTurnStartIndex,
	runContextCompression,
	shouldAutoCompressAgent,
} from '~/ai/chat/runtime/context-compression'
import type { AppUIMessage } from '~/ai/chat/types'

const generateText = vi.hoisted(() => vi.fn())

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

function message(
	id: string,
	role: 'user' | 'assistant',
	createdAt: number,
): AppUIMessage {
	return {
		id,
		role,
		metadata: { createdAt },
		parts: [{ type: 'text', text: id }],
	}
}

describe('context compression', () => {
	beforeEach(() => {
		generateText.mockReset()
		generateText.mockResolvedValue({ text: 'compressed context' })
	})

	it('inserts the summary before the recent turns that fit the token budget', async () => {
		const master = createEmptyMasterAgent(1)
		master.timeline = [
			message('u1', 'user', 1),
			message('a1', 'assistant', 2),
			message('u2', 'user', 3),
			message('a2', 'assistant', 4),
			message('u3', 'user', 5),
			message('a3', 'assistant', 6),
			message('u4', 'user', 7),
		]
		master.timeline[0].parts = [
			{ type: 'text', text: 'old context '.repeat(10_000) },
		]
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const store = {
			upsertSessionIndexItem: vi.fn(),
			persistSession: vi.fn(async () => undefined),
			persistMetaAndIndex: vi.fn(async () => undefined),
		}
		const factory = new MessageFactory(
			{ app: {} } as never,
			{} as never,
			vi.fn(),
		)

		await runContextCompression({
			provider: {} as never,
			model: { id: 'model' } as never,
			session,
			agent: master,
			store: store as never,
			messageFactory: factory,
		})

		expect(master.timeline.map((item) => item.id)).toEqual([
			'u1',
			'a1',
			'u2',
			'a2',
			'u3',
			'a3',
			'u4',
			expect.stringMatching(/^checkpoint/),
		])
		const selected = selectContextTimeline(master.timeline)
		expect(selected.slice(1).map((item) => item.id)).toEqual([
			'u2',
			'a2',
			'u3',
			'a3',
			'u4',
		])
		expect(selected[0].parts[0]).toMatchObject({
			type: 'data-context-checkpoint',
			data: {
				mode: 'summary',
				summary: 'compressed context',
				preservedTurnCount: 3,
			},
		})
	})

	it('preserves more short turns and always keeps an oversized current turn', async () => {
		const shortTurns = [
			message('u1', 'user', 1),
			message('a1', 'assistant', 2),
			message('u2', 'user', 3),
			message('a2', 'assistant', 4),
			message('u3', 'user', 5),
		]
		expect(await findRecentTurnStartIndex(shortTurns, 2048)).toBe(0)

		const oversizedCurrentTurn = message('current', 'user', 6)
		oversizedCurrentTurn.parts = [
			{ type: 'text', text: 'large request '.repeat(10_000) },
		]
		expect(
			await findRecentTurnStartIndex(
				[...shortTurns, oversizedCurrentTurn],
				2048,
			),
		).toBe(shortTurns.length)
	})

	it('resolves preserved turns recursively across appended checkpoints', () => {
		const checkpoint = (
			id: string,
			preservedTurnCount: number,
		): AppUIMessage => ({
			id,
			role: 'user',
			metadata: { createdAt: 10 },
			parts: [
				{
					type: 'data-context-checkpoint',
					data: {
						mode: 'summary',
						summary: id,
						preservedTurnCount,
					},
				},
			],
		})
		const timeline = [
			message('u1', 'user', 1),
			message('a1', 'assistant', 2),
			checkpoint('c1', 1),
			message('u2', 'user', 3),
			message('a2', 'assistant', 4),
			checkpoint('c2', 2),
			message('u3', 'user', 5),
		]

		expect(selectContextTimeline(timeline).map((item) => item.id)).toEqual([
			'c2',
			'u1',
			'a1',
			'u2',
			'a2',
			'u3',
		])
	})

	it('ignores usage from retained turns until a new response is generated', () => {
		const agent = createEmptyMasterAgent(1)
		const checkpoint: AppUIMessage = {
			id: 'checkpoint',
			role: 'user',
			metadata: { createdAt: 100 },
			parts: [
				{
					type: 'data-context-checkpoint',
					data: { mode: 'summary', summary: 'summary' },
				},
			],
		}
		const oldAssistant = message('old-assistant', 'assistant', 50)
		oldAssistant.metadata!.llm = {
			usage: {
				inputTokens: 95_000,
				outputTokens: 0,
				totalTokens: 95_000,
			} as never,
		}
		agent.timeline = [checkpoint, oldAssistant]

		expect(
			shouldAutoCompressAgent(agent, { limit: { context: 100_000 } } as never),
		).toBe(false)

		const newAssistant = message('new-assistant', 'assistant', 101)
		newAssistant.metadata!.llm = {
			usage: {
				inputTokens: 95_000,
				outputTokens: 0,
				totalTokens: 95_000,
			} as never,
		}
		agent.timeline.push(newAssistant)
		expect(
			shouldAutoCompressAgent(agent, { limit: { context: 100_000 } } as never),
		).toBe(true)
	})
})
