import { describe, expect, it } from 'vitest'
import type { SessionRuntimeState } from '~/ai/chat/runtime/chat-state'
import {
	cancelActiveTurn,
	claimNextTurn,
	completeActiveTurn,
	createMasterTurnScheduler,
	enqueueAgentInput,
	enqueueUserSubmission,
	isTurnAlive,
	ownsActiveTurn,
} from '~/ai/chat/runtime/master-turn-scheduler'

function runtime(): SessionRuntimeState {
	return {
		runState: 'idle',
		draft: { text: '', userContext: [] },
		scheduler: createMasterTurnScheduler(),
	}
}

describe('master turn scheduler', () => {
	it('claims queued submissions in FIFO order and only once', () => {
		const state = runtime()
		enqueueUserSubmission(state, {
			text: 'Hello 你好 🌿 one',
			userContext: [],
		})
		enqueueUserSubmission(state, {
			text: 'Hello 你好 🌿 two',
			userContext: [],
		})

		const first = claimNextTurn(state)
		expect(first?.turn).toMatchObject({
			kind: 'user-submission',
			submission: { text: 'Hello 你好 🌿 one' },
		})
		expect(state.scheduler.queued).toHaveLength(1)
		expect(claimNextTurn(state)).toBeUndefined()

		completeActiveTurn(state, first!.turn.turnId, first!.abortController.signal)
		const second = claimNextTurn(state)
		expect(second?.turn).toMatchObject({
			kind: 'user-submission',
			submission: { text: 'Hello 你好 🌿 two' },
		})
	})

	it('keeps ownership valid after abort until the active slot is cancelled', () => {
		const state = runtime()
		enqueueUserSubmission(state, {
			text: '中性内容 Hello 你好 🌿',
			userContext: [],
		})
		const active = claimNextTurn(state)!
		const signal = active.abortController.signal

		active.abortController.abort()
		expect(ownsActiveTurn(state, active.turn.turnId, signal)).toBe(true)
		expect(
			isTurnAlive(state, 'session', active.turn.turnId, signal, () => false),
		).toBe(false)
		expect(cancelActiveTurn(state, active.turn.turnId, signal)).toBe(true)
		expect(state.scheduler.active).toBeUndefined()
	})

	it('drops an agent input whose origin was aborted before claim', () => {
		const state = runtime()
		const originController = new AbortController()
		enqueueAgentInput(
			state,
			{
				id: 'input',
				role: 'user',
				metadata: { createdAt: 1 },
				parts: [{ type: 'text', text: 'Hello 你好 🌿' }],
			},
			{ turnId: 'T1', signal: originController.signal },
		)
		originController.abort()

		expect(claimNextTurn(state)).toBeUndefined()
		expect(state.scheduler.queued).toEqual([])
	})
})
