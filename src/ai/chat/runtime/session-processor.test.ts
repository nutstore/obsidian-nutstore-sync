import { describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '~/ai/chat/domain'
import { ChatState } from '~/ai/chat/runtime/chat-state'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import { SessionProcessor } from '~/ai/chat/runtime/session-processor'
import { createMasterTurnScheduler } from '~/ai/chat/runtime/master-turn-scheduler'
import type { AppUIMessage } from '~/ai/chat/types'
import type { AgentRunner } from '~/ai/chat/runtime/agent-runner'

const TEXT_ONE = 'Hello 你好 🌿 one'
const TEXT_TWO = 'Hello 你好 🌿 two'

function createHarness(
	runTurn: (options: Parameters<AgentRunner['runTurn']>[0]) => Promise<unknown>,
	prepareUserContext: (
		items: unknown[],
	) => Promise<{ dedupedItems: unknown[] }> = async (items) => ({
		dedupedItems: items,
	}),
) {
	const master = createEmptyMasterAgent(1)
	const session: ChatSession = {
		schemaVersion: 2,
		id: 'session',
		createdAt: 1,
		updatedAt: 1,
		model: { providerId: 'provider', modelId: 'model' },
		subagents: { master },
	}
	const state = new ChatState()
	state.loadedSessions.set(session.id, session)
	const runtimeStates = new RuntimeStates(state)
	const store = {
		persistSession: vi.fn(async () => undefined),
		persistMetaAndIndex: vi.fn(async () => undefined),
		upsertSessionIndexItem: vi.fn(),
	}
	let messageNumber = 0
	const appendUserMessage = vi.fn(
		async (
			agent: typeof master,
			text: string,
			currentSession: ChatSession,
			_context: unknown,
			isCurrent?: () => boolean,
		) => {
			if (isCurrent && !isCurrent()) return undefined
			const message: AppUIMessage = {
				id: `user-${++messageNumber}`,
				role: 'user',
				metadata: { createdAt: currentSession.updatedAt },
				parts: [{ type: 'text', text }],
			}
			agent.timeline.push(message)
			return message
		},
	)
	const messageFactory = {
		getActiveAgent: () => master,
		appendUserMessage,
		appendAgentInput: vi.fn(() => true),
		removeIncompleteToolCalls: vi.fn(() => false),
		reportFatalError: vi.fn(),
	}
	const messageOps = {
		beginRegeneration: vi.fn(),
		commitRegeneration: vi.fn(),
		rollbackRegeneration: vi.fn(),
	}
	const selection = {
		getProviderOrThrow: () => ({ id: 'provider', name: 'Provider' }),
		getModelOrThrow: () => ({ id: 'model', name: 'Model' }),
	} as never
	const userContextManager = {
		prepareUserContextForMessage: prepareUserContext,
	} as never
	const agentRunner = { runTurn } as never
	const compactionCoordinator = {
		inspect: () => 'ready',
		compact: async () => ({
			beforeTokens: 1,
			afterTokens: 1,
			revision: 'test',
		}),
		shouldSuspendAtSafePoint: () => false,
		cancel: vi.fn(),
	}
	const reportTransientError = vi.fn()
	const processor = new SessionProcessor(
		async () => undefined,
		state,
		runtimeStates,
		store as never,
		vi.fn(),
		selection,
		messageFactory as never,
		messageOps as never,
		userContextManager,
		agentRunner,
		compactionCoordinator as never,
		{
			cancelAllNonTerminalAgents: vi.fn(() => false),
			startQueuedAgentsForSession: vi.fn(),
		},
		reportTransientError,
	)
	return {
		master,
		processor,
		runtime: runtimeStates.get(session.id),
		session,
		messageFactory,
		messageOps,
		compactionCoordinator,
		store,
		reportTransientError,
	}
}

describe('SessionProcessor master turn worker', () => {
	it('sends all queued messages together at a tool boundary without aborting originating work', async () => {
		let release!: () => void
		const boundary = new Promise<void>((resolve) => {
			release = resolve
		})
		const origins: AbortSignal[] = []
		const runTurn = vi.fn(
			async (options: Parameters<AgentRunner['runTurn']>[0]) => {
				origins.push(options.taskOrigin.signal)
				if (origins.length === 1) {
					expect(options.shouldYieldAfterToolStep?.()).toBe(false)
					await boundary
					expect(options.shouldYieldAfterToolStep?.()).toBe(true)
				}
				if (origins.length === 2) {
					expect(options.agent.timeline).toHaveLength(3)
				}
				return { status: 'completed', text: TEXT_TWO }
			},
		)
		const { master, processor, runtime, messageFactory } =
			createHarness(runTurn)
		processor.enqueueUserSubmission('session', {
			text: TEXT_ONE,
			userContext: [],
		})
		await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(1))
		processor.enqueueUserSubmission('session', {
			text: TEXT_TWO,
			userContext: [],
		})
		processor.enqueueUserSubmission('session', {
			text: 'Compare 比较 🌱',
			userContext: [],
		})
		expect(master.timeline).toHaveLength(1)
		release()
		await runtime.processing
		expect(runTurn).toHaveBeenCalledTimes(2)
		expect(master.timeline.map((message) => message.parts[0])).toEqual([
			{ type: 'text', text: TEXT_ONE },
			{ type: 'text', text: TEXT_TWO },
			{ type: 'text', text: 'Compare 比较 🌱' },
		])
		expect(origins.every((signal) => !signal.aborted)).toBe(true)
		expect(messageFactory.removeIncompleteToolCalls).not.toHaveBeenCalled()
		expect(runtime.scheduler.queued).toEqual([])
	})

	it('does not lose later user input when preparing one item in a claimed batch fails', async () => {
		let releaseFirstTurn!: () => void
		const firstTurn = new Promise<void>((resolve) => {
			releaseFirstTurn = resolve
		})
		const runTurn = vi.fn(async () => {
			if (runTurn.mock.calls.length === 1) await firstTurn
			return { status: 'completed', text: 'Completed 完成 🌿' }
		})
		let preparation = 0
		const prepare = vi.fn(async (items: unknown[]) => {
			preparation += 1
			if (preparation === 3)
				throw new Error('Context unavailable 上下文不可用 🌧️')
			return { dedupedItems: items }
		})
		const { master, processor, runtime } = createHarness(runTurn, prepare)

		processor.enqueueUserSubmission('session', {
			text: 'Initial 初始 🌱',
			userContext: [],
		})
		await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(1))
		processor.enqueueUserSubmission('session', {
			text: 'First queued 第一条 🌿',
			userContext: [],
		})
		processor.enqueueUserSubmission('session', {
			text: 'Second queued 第二条 🌻',
			userContext: [],
		})

		releaseFirstTurn()
		await runtime.processing

		expect(
			master.timeline.flatMap((message) =>
				message.parts.flatMap((part) =>
					part.type === 'text' ? [part.text] : [],
				),
			),
		).toEqual([
			'Initial 初始 🌱',
			'First queued 第一条 🌿',
			'Second queued 第二条 🌻',
		])
	})

	it('does not lose later user input when persisting one item in a claimed batch fails', async () => {
		let releaseFirstTurn!: () => void
		const firstTurn = new Promise<void>((resolve) => {
			releaseFirstTurn = resolve
		})
		const runTurn = vi.fn(async () => {
			if (runTurn.mock.calls.length === 1) await firstTurn
			return { status: 'completed', text: 'Completed 完成 🌿' }
		})
		const { master, processor, runtime, store } = createHarness(runTurn)

		processor.enqueueUserSubmission('session', {
			text: 'Initial 初始 🌱',
			userContext: [],
		})
		await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(1))
		processor.enqueueUserSubmission('session', {
			text: 'First queued 第一条 🌿',
			userContext: [],
		})
		processor.enqueueUserSubmission('session', {
			text: 'Second queued 第二条 🌻',
			userContext: [],
		})
		store.persistSession.mockRejectedValueOnce(
			new Error('Storage unavailable 存储暂不可用 🌧️'),
		)

		releaseFirstTurn()
		await runtime.processing

		expect(
			master.timeline.flatMap((message) =>
				message.parts.flatMap((part) =>
					part.type === 'text' ? [part.text] : [],
				),
			),
		).toEqual([
			'Initial 初始 🌱',
			'First queued 第一条 🌿',
			'Second queued 第二条 🌻',
		])
	})

	it('cancels T1 without replaying it and drains queued T2', async () => {
		let callCount = 0
		const runTurn = vi.fn(({ abortSignal }: { abortSignal?: AbortSignal }) => {
			callCount += 1
			if (callCount === 1) {
				return new Promise((_, reject) => {
					abortSignal?.addEventListener(
						'abort',
						() => reject(new Error('test abort')),
						{ once: true },
					)
				})
			}
			return Promise.resolve({ status: 'completed', text: TEXT_TWO })
		})
		const { master, processor, runtime } = createHarness(runTurn)

		processor.enqueueUserSubmission('session', {
			text: TEXT_ONE,
			userContext: [],
		})
		await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(1))
		const firstWorker = runtime.processing

		processor.enqueueUserSubmission('session', {
			text: TEXT_TWO,
			userContext: [],
		})
		expect(runtime.scheduler.queued).toHaveLength(1)
		expect(master.timeline.map((message) => message.id)).toEqual(['user-1'])

		await processor.stopActiveTurn('session')
		await firstWorker

		expect(runTurn).toHaveBeenCalledTimes(2)
		expect(runtime.scheduler.queued).toEqual([])
		expect(runtime.scheduler.active).toBeUndefined()
		expect(master.timeline.map((message) => message.id)).toEqual([
			'user-1',
			'user-2',
		])
	})

	it('rechecks the scheduler after an empty worker to avoid a lost wake-up', async () => {
		const runTurn = vi.fn(async () => ({ status: 'completed', text: TEXT_TWO }))
		const { processor, runtime } = createHarness(runTurn)

		const emptyWorker = processor.start('session')
		processor.enqueueUserSubmission('session', {
			text: TEXT_TWO,
			userContext: [],
		})
		await emptyWorker
		await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(1))
		await runtime.processing

		expect(runtime.scheduler.queued).toEqual([])
		expect(runtime.scheduler.active).toBeUndefined()
	})

	it('drains queued work after an unexpected worker rejection', async () => {
		let releaseFirstTurn:
			((result: { status: string; text: string }) => void) | undefined
		const runTurn = vi.fn(() => {
			if (runTurn.mock.calls.length === 1) {
				return new Promise<{ status: string; text: string }>((resolve) => {
					releaseFirstTurn = resolve
				})
			}
			return Promise.resolve({ status: 'completed', text: TEXT_TWO })
		})
		const { master, processor, runtime, reportTransientError } =
			createHarness(runTurn)

		processor.enqueueUserSubmission('session', {
			text: TEXT_ONE,
			userContext: [],
		})
		await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(1))
		processor.enqueueUserSubmission('session', {
			text: TEXT_TWO,
			userContext: [],
		})
		master.pendingInputs.push({
			id: 'unexpected-pending-input',
			role: 'user',
			metadata: { createdAt: 1 },
			parts: [{ type: 'text', text: '中性内容 🌿' }],
		})
		reportTransientError.mockImplementationOnce(() => {
			master.pendingInputs = []
		})

		releaseFirstTurn!({ status: 'completed', text: TEXT_ONE })

		await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(2))
		await runtime.processing

		expect(reportTransientError).toHaveBeenCalledWith(
			'Master agent pendingInputs must remain empty',
		)
		expect(runtime.scheduler.queued).toEqual([])
		expect(runtime.scheduler.active).toBeUndefined()
	})

	it('claims queued work without a fallible pre-claim persistence step', async () => {
		const runTurn = vi.fn(async () => ({ status: 'completed', text: TEXT_TWO }))
		const { processor, runtime, messageFactory, store, reportTransientError } =
			createHarness(runTurn)
		messageFactory.removeIncompleteToolCalls.mockReturnValue(true)
		store.persistSession.mockRejectedValueOnce(
			new Error('neutral persistence failure'),
		)

		processor.enqueueUserSubmission('session', {
			text: TEXT_ONE,
			userContext: [],
		})
		await runtime.processing

		const [persistedSession] = (
			store.persistSession.mock.calls as unknown as Array<[ChatSession]>
		)[0]
		expect(persistedSession).toMatchObject({
			subagents: {
				master: {
					timeline: [{ parts: [{ type: 'text', text: TEXT_ONE }] }],
				},
			},
		})
		expect(runTurn).not.toHaveBeenCalled()
		expect(runtime.scheduler.queued).toEqual([])
		expect(runtime.scheduler.active).toBeUndefined()
		expect(reportTransientError).not.toHaveBeenCalled()
	})

	it('materializes a claimed user submission after Stop without starting the model', async () => {
		let releasePrepare:
			((value: { dedupedItems: unknown[] }) => void) | undefined
		const prepare = vi.fn(
			() =>
				new Promise<{ dedupedItems: unknown[] }>((resolve) => {
					releasePrepare = resolve
				}),
		)
		const runTurn = vi.fn(async () => ({ status: 'completed', text: TEXT_TWO }))
		const { master, processor, runtime } = createHarness(runTurn, prepare)

		processor.enqueueUserSubmission('session', {
			text: TEXT_ONE,
			userContext: [],
		})
		await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1))
		const worker = runtime.processing
		await processor.stopActiveTurn('session')
		releasePrepare!({ dedupedItems: [] })
		await worker

		expect(runTurn).not.toHaveBeenCalled()
		expect(master.timeline.map((message) => message.parts[0])).toEqual([
			{ type: 'text', text: TEXT_ONE },
		])
		expect(runtime.scheduler.active).toBeUndefined()
	})

	it('stops only the active master turn compaction', async () => {
		const runTurn = vi.fn(
			({ abortSignal }: { abortSignal?: AbortSignal }) =>
				new Promise((_, reject) => {
					abortSignal?.addEventListener(
						'abort',
						() => reject(new Error('neutral abort')),
						{ once: true },
					)
				}),
		)
		const { processor, runtime, compactionCoordinator } = createHarness(runTurn)

		processor.enqueueUserSubmission('session', {
			text: TEXT_ONE,
			userContext: [],
		})
		await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(1))
		await processor.stopActiveTurn('session')
		await runtime.processing

		expect(compactionCoordinator.cancel).toHaveBeenCalledWith(
			'session',
			'master',
		)
		expect(compactionCoordinator.cancel).not.toHaveBeenCalledWith(
			'session',
			undefined,
		)
	})

	it('does not infer work from a user message at the timeline tail', async () => {
		const runTurn = vi.fn(async () => ({ status: 'completed', text: TEXT_TWO }))
		const { master, processor, runtime } = createHarness(runTurn)
		master.timeline.push({
			id: 'historical-user',
			role: 'user',
			metadata: { createdAt: 1 },
			parts: [{ type: 'text', text: TEXT_ONE }],
		})
		runtime.scheduler = createMasterTurnScheduler()

		await processor.start('session')

		expect(runTurn).not.toHaveBeenCalled()
	})

	it('records the configured model on a normal turn failure', async () => {
		const runTurn = vi.fn(async () => {
			throw new Error('neutral model failure')
		})
		const { processor, runtime, messageFactory } = createHarness(runTurn)

		processor.enqueueUserSubmission('session', {
			text: TEXT_ONE,
			userContext: [],
		})
		await runtime.processing

		expect(messageFactory.reportFatalError).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(String),
			{
				providerId: 'provider',
				providerName: 'Provider',
				modelId: 'model',
				modelName: 'Model',
			},
			expect.anything(),
		)
	})

	it('restores the exact transcript when regeneration fails', async () => {
		const request = {
			id: 'request',
			role: 'user' as const,
			metadata: { createdAt: 1 },
			parts: [{ type: 'text' as const, text: TEXT_ONE }],
		}
		const response = {
			id: 'response',
			role: 'assistant' as const,
			metadata: { createdAt: 2 },
			parts: [{ type: 'text' as const, text: TEXT_TWO }],
		}
		const originalTimeline = [request, response]
		const runTurn = vi.fn(async () => {
			throw new Error('neutral regeneration failure')
		})
		const { master, processor, runtime, session, messageFactory, messageOps } =
			createHarness(runTurn)
		master.timeline = originalTimeline.slice()
		const transaction = {
			targetMessageId: response.id,
			targetToolCallIds: [],
			originalTimeline,
			originalOperations: {},
			originalToolTimings: {},
			originalSessionUpdatedAt: session.updatedAt,
			originalSessionIndexPosition: -1,
			prefixLength: 1,
			suffix: [],
		}
		messageOps.beginRegeneration.mockImplementation(async () => {
			master.timeline = [request]
			return transaction
		})
		messageOps.rollbackRegeneration.mockImplementation(() => {
			master.timeline = originalTimeline.slice()
		})
		messageFactory.reportFatalError.mockImplementation(
			(_currentSession: ChatSession, message: string) => {
				master.timeline.push({
					id: 'unexpected-error',
					role: 'assistant',
					metadata: { createdAt: 3 },
					parts: [{ type: 'text', text: message }],
				})
			},
		)

		processor.enqueueRegenerate(session.id, response.id)
		await runtime.processing

		expect(master.timeline).toEqual(originalTimeline)
		expect(messageFactory.reportFatalError).not.toHaveBeenCalled()
	})

	it('keeps the streamed replacement and restores the suffix when regeneration stops', async () => {
		const prefix = {
			id: 'prefix',
			role: 'user' as const,
			metadata: { createdAt: 1 },
			parts: [{ type: 'text' as const, text: TEXT_ONE }],
		}
		const target = {
			id: 'target',
			role: 'assistant' as const,
			metadata: { createdAt: 2 },
			parts: [{ type: 'text' as const, text: 'Original response' }],
		}
		const suffix = {
			id: 'suffix',
			role: 'user' as const,
			metadata: { createdAt: 3 },
			parts: [{ type: 'text' as const, text: TEXT_TWO }],
		}
		const partial = {
			id: 'replacement-partial',
			role: 'assistant' as const,
			metadata: { createdAt: 4 },
			parts: [{ type: 'text' as const, text: 'Replacement partial 🌿' }],
		}
		let masterForRun: ReturnType<typeof createEmptyMasterAgent> | undefined
		const runTurn = vi.fn(
			({ abortSignal }: { abortSignal?: AbortSignal }) =>
				new Promise((_, reject) => {
					masterForRun!.timeline.push(partial)
					abortSignal?.addEventListener(
						'abort',
						() => reject(new Error('neutral abort')),
						{ once: true },
					)
				}),
		)
		const { master, processor, runtime, session, messageFactory, messageOps } =
			createHarness(runTurn)
		masterForRun = master
		const originalTimeline = [prefix, target, suffix]
		master.timeline = originalTimeline.slice()
		const transaction = {
			targetMessageId: target.id,
			targetToolCallIds: [],
			originalTimeline,
			originalOperations: {},
			originalToolTimings: {},
			originalSessionUpdatedAt: session.updatedAt,
			originalSessionIndexPosition: -1,
			prefixLength: 1,
			suffix: [suffix],
		}
		messageOps.beginRegeneration.mockImplementation(async () => {
			master.timeline = [prefix]
			return transaction
		})
		messageOps.commitRegeneration.mockImplementation(() => {
			master.timeline = [...master.timeline, suffix]
		})

		processor.enqueueRegenerate(session.id, target.id)
		await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(1))
		await processor.stopActiveTurn(session.id)
		await runtime.processing

		expect(master.timeline).toEqual([prefix, partial, suffix])
		expect(messageFactory.removeIncompleteToolCalls).toHaveBeenCalledWith(
			master,
		)
	})

	it('commits a completed regeneration once when Stop arrives during persistence', async () => {
		const prefix = {
			id: 'prefix',
			role: 'user' as const,
			metadata: { createdAt: 1 },
			parts: [{ type: 'text' as const, text: TEXT_ONE }],
		}
		const target = {
			id: 'target',
			role: 'assistant' as const,
			metadata: { createdAt: 2 },
			parts: [{ type: 'text' as const, text: 'Original response' }],
		}
		const replacement = {
			id: 'replacement',
			role: 'assistant' as const,
			metadata: { createdAt: 3 },
			parts: [{ type: 'text' as const, text: 'Replacement 你好 🌿' }],
		}
		const suffix = {
			id: 'suffix',
			role: 'user' as const,
			metadata: { createdAt: 4 },
			parts: [{ type: 'text' as const, text: TEXT_TWO }],
		}
		let releasePersist: (() => void) | undefined
		const runTurn = vi.fn(async () => ({ status: 'completed', text: TEXT_TWO }))
		const { master, processor, runtime, session, messageOps, store } =
			createHarness(runTurn)
		master.timeline = [prefix, target, suffix]
		const transaction = {
			targetMessageId: target.id,
			targetToolCallIds: [],
			originalTimeline: master.timeline.slice(),
			originalOperations: {},
			originalToolTimings: {},
			originalSessionUpdatedAt: session.updatedAt,
			originalSessionIndexPosition: -1,
			prefixLength: 1,
			suffix: [suffix],
		}
		messageOps.beginRegeneration.mockImplementation(async () => {
			master.timeline = [prefix, replacement]
			return transaction
		})
		messageOps.commitRegeneration.mockImplementation(() => {
			master.timeline.push(...transaction.suffix)
		})
		messageOps.rollbackRegeneration.mockImplementation(() => {
			master.timeline = transaction.originalTimeline.slice()
		})
		store.persistSession.mockImplementationOnce(
			() =>
				new Promise<undefined>((resolve) => {
					releasePersist = () => resolve(undefined)
				}),
		)

		processor.enqueueRegenerate(session.id, target.id)
		await vi.waitFor(() =>
			expect(store.persistSession).toHaveBeenCalledTimes(1),
		)
		await processor.stopActiveTurn(session.id)
		releasePersist!()
		await runtime.processing

		expect(messageOps.commitRegeneration).toHaveBeenCalledTimes(1)
		expect(master.timeline).toEqual([prefix, replacement, suffix])
	})
})
