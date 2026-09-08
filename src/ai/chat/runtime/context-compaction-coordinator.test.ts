import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '~/ai/chat/domain'
import { MessageFactory } from '~/ai/chat/messages/message-factory'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import {
	ContextCompactionCoordinator,
	createContextCompactionRevision,
	type ContextCompactionRequest,
} from '~/ai/chat/runtime/context-compaction-coordinator'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'

const generateText = vi.hoisted(() => vi.fn())
const NEUTRAL_TEXT = 'Hello 你好 🌿'

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
		parts: [{ type: 'text', text: `${NEUTRAL_TEXT} ${id}` }],
	}
}

function createPressureState() {
	const agent = createEmptyMasterAgent(1)
	agent.timeline = [
		{
			...message('neutral-old-user', 'user', 1),
			parts: [{ type: 'text', text: NEUTRAL_TEXT.repeat(10_000) }],
		},
		message('neutral-old-assistant', 'assistant', 2),
		message('neutral-current-user', 'user', 3),
	]
	agent.timeline[1].metadata!.llm = {
		usage: {
			inputTokens: 82_000,
			outputTokens: 0,
			totalTokens: 82_000,
		} as never,
	}
	const session: ChatSession = {
		schemaVersion: 2,
		id: 'neutral-session',
		createdAt: 1,
		updatedAt: 1,
		subagents: { master: agent },
	}
	return { agent, session }
}

function createHarness() {
	const store = {
		persistSession: vi.fn(async () => undefined),
		persistMetaAndIndex: vi.fn(async () => undefined),
		upsertSessionIndexItem: vi.fn(),
	}
	return {
		store,
		coordinator: new ContextCompactionCoordinator(
			store as never,
			new MessageFactory({} as never, vi.fn()),
		),
	}
}

function request(
	session: ChatSession,
	agent: ChatAgentState,
	revision: string,
): ContextCompactionRequest {
	return {
		session,
		agent,
		provider: { id: 'neutral-provider' } as never,
		model: {
			id: 'neutral-model',
			limit: { context: 100_000, output: 10_000 },
		} as never,
		revision,
		resolveSummaryContext: async () => ({}),
		isCancelled: () => false,
		isCurrent: () => true,
	}
}

describe('ContextCompactionCoordinator', () => {
	beforeEach(() => generateText.mockReset())

	it('changes the revision with model, prompt, and MCP selection', () => {
		const { session } = createPressureState()
		const provider = { id: 'neutral-provider' } as never
		const model = { id: 'neutral-model' } as never
		const initial = createContextCompactionRevision(session, provider, model)
		session.systemPrompt = NEUTRAL_TEXT
		const withPrompt = createContextCompactionRevision(session, provider, model)
		session.disabledMcpServers = ['neutral-mcp']
		const withMcpSelection = createContextCompactionRevision(
			session,
			provider,
			model,
		)
		const withNewModel = createContextCompactionRevision(session, provider, {
			id: 'neutral-new-model',
		} as never)

		expect(
			new Set([initial, withPrompt, withMcpSelection, withNewModel]),
		).toHaveProperty('size', 4)
	})

	it('reports a failed job when the summarizer returns no text', async () => {
		generateText.mockResolvedValue({ text: ' \n\t ' })
		const { agent, session } = createPressureState()
		const { coordinator } = createHarness()
		const compactionRequest = request(session, agent, 'neutral-revision')

		expect(coordinator.inspect(compactionRequest)).toBe('ready')
		await expect(coordinator.compact(compactionRequest)).rejects.toMatchObject({
			reason: 'failed',
		})
		expect(generateText).toHaveBeenCalledTimes(1)
	})

	it('reports measurable progress after committing a summary', async () => {
		generateText.mockResolvedValue({ text: NEUTRAL_TEXT })
		const { agent, session } = createPressureState()
		const { coordinator } = createHarness()
		const compactionRequest = request(session, agent, 'neutral-revision')

		coordinator.inspect(compactionRequest)
		const progress = await coordinator.compact(compactionRequest)

		expect(progress.afterTokens).toBeLessThan(progress.beforeTokens)
		expect(progress.revision).toContain('neutral-revision')
	})

	it('rejects a ready summary generated with a different configuration', async () => {
		generateText.mockResolvedValue({ text: NEUTRAL_TEXT })
		const { agent, session } = createPressureState()
		const { coordinator, store } = createHarness()
		const originalRequest = request(session, agent, 'neutral-old-revision')

		expect(coordinator.inspect(originalRequest)).toBe('ready')
		await vi.waitFor(() => expect(generateText).toHaveBeenCalledTimes(1))
		await Promise.resolve()

		await expect(
			coordinator.compact({
				...originalRequest,
				isCurrent: () => false,
			}),
		).rejects.toMatchObject({ reason: 'stale' })
		expect(store.persistSession).not.toHaveBeenCalled()
	})

	it('does not restart compaction after cancellation', () => {
		const cancelled = true
		const { agent, session } = createPressureState()
		const { coordinator } = createHarness()
		const compactionRequest = {
			...request(session, agent, 'neutral-revision'),
			isCancelled: () => cancelled,
		}

		coordinator.cancel(session.id, agent.id)

		expect(coordinator.inspect(compactionRequest)).toBe('ready')
		expect(generateText).not.toHaveBeenCalled()
	})

	it('aborts an active compaction without starting a replacement', async () => {
		let cancelled = false
		let finishProviderSetup: (() => void) | undefined
		const { agent, session } = createPressureState()
		const { coordinator } = createHarness()
		const compactionRequest = {
			...request(session, agent, 'neutral-revision'),
			ensureProviderReady: () =>
				new Promise<void>((resolve) => {
					finishProviderSetup = resolve
				}),
			isCancelled: () => cancelled,
		}

		coordinator.inspect(compactionRequest)
		const completion = coordinator.compact(compactionRequest)
		await vi.waitFor(() => expect(finishProviderSetup).toBeDefined())
		cancelled = true
		coordinator.cancel(session.id, agent.id)
		finishProviderSetup!()

		await expect(completion).rejects.toMatchObject({ name: 'AbortError' })
		expect(coordinator.inspect(compactionRequest)).toBe('ready')
		expect(generateText).not.toHaveBeenCalled()
	})
})
