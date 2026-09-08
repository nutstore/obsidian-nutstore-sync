import { describe, expect, it, vi } from 'vitest'
import { runAgentLoop } from '~/ai/chat/runtime/agent-loop'

const NEUTRAL_TEXT = 'Hello 你好 🌿'

function request() {
	return { isCancelled: () => false } as never
}

describe('runAgentLoop', () => {
	it('preserves continuation across context compaction', async () => {
		const continuation = {
			consecutiveCount: 2,
			isRepeatedTooManyTimes: false,
		} as never
		const inspect = vi
			.fn()
			.mockReturnValueOnce('ready')
			.mockReturnValueOnce('compact')
			.mockReturnValueOnce('ready')
		const compact = vi.fn(async () => ({
			beforeTokens: 120,
			afterTokens: 40,
			revision: 'neutral-revision',
		}))
		const runTurn = vi
			.fn()
			.mockResolvedValueOnce({ status: 'needs-compaction', continuation })
			.mockResolvedValueOnce({ status: 'completed', text: NEUTRAL_TEXT })
		const states: string[] = []

		const result = await runAgentLoop({
			compactionCoordinator: {
				inspect,
				compact,
				shouldSuspendAtSafePoint: vi.fn(() => false),
			} as never,
			createCompactionRequest: request,
			isTurnAlive: () => true,
			runTurn,
			onStateChange: (state) => states.push(state),
		})

		expect(result).toEqual({ status: 'completed', text: NEUTRAL_TEXT })
		expect(runTurn.mock.calls[1][0]).toBe(continuation)
		expect(states).toEqual([
			'checking-context',
			'running-turn',
			'checking-context',
			'compacting',
			'checking-context',
			'running-turn',
		])
	})

	it('makes cancellation terminal before starting context work', async () => {
		const inspect = vi.fn()
		const runTurn = vi.fn()

		const result = await runAgentLoop({
			compactionCoordinator: { inspect } as never,
			createCompactionRequest: request,
			isTurnAlive: () => false,
			runTurn,
		})

		expect(result).toEqual({ status: 'cancelled' })
		expect(inspect).not.toHaveBeenCalled()
		expect(runTurn).not.toHaveBeenCalled()
	})

	it('owns cancellation when compaction is aborted', async () => {
		let cancelled = false
		const compact = vi.fn(async () => {
			cancelled = true
			throw new Error('neutral abort')
		})

		const result = await runAgentLoop({
			compactionCoordinator: {
				inspect: vi.fn(() => 'compact'),
				compact,
			} as never,
			createCompactionRequest: request,
			isTurnAlive: () => !cancelled,
			runTurn: vi.fn(),
		})

		expect(result).toEqual({ status: 'cancelled' })
		expect(compact).toHaveBeenCalledTimes(1)
	})

	it('fails when a successful compaction makes no progress', async () => {
		const result = await runAgentLoop({
			compactionCoordinator: {
				inspect: vi.fn(() => 'compact'),
				compact: vi.fn(async () => ({
					beforeTokens: 80,
					afterTokens: 80,
					revision: 'neutral-revision',
				})),
			} as never,
			createCompactionRequest: request,
			isTurnAlive: () => true,
			runTurn: vi.fn(),
		})

		expect(result).toMatchObject({
			status: 'failed',
			error: { type: 'compaction-no-progress' },
		})
	})

	it('keeps runner failures structured inside the runtime boundary', async () => {
		const cause = new Error(NEUTRAL_TEXT)
		const result = await runAgentLoop({
			compactionCoordinator: {
				inspect: vi.fn(() => 'ready'),
				shouldSuspendAtSafePoint: vi.fn(() => false),
			} as never,
			createCompactionRequest: request,
			isTurnAlive: () => true,
			runTurn: vi.fn(async () => {
				throw cause
			}),
		})

		expect(result).toEqual({
			status: 'failed',
			error: { type: 'turn-failed', cause },
		})
	})
})
