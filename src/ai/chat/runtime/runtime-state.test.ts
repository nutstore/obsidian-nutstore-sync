import { describe, expect, it } from 'vitest'
import { ChatState } from '~/ai/chat/runtime/chat-state'
import {
	claimNextTurn,
	enqueueUserSubmission,
} from '~/ai/chat/runtime/master-turn-scheduler'
import {
	isSessionExecutionPending,
	RuntimeStates,
} from '~/ai/chat/runtime/runtime-state'

describe('RuntimeStates', () => {
	it('uses execution ownership rather than UI state to gate work', () => {
		const state = new ChatState()
		const runtime = new RuntimeStates(state).get('neutral-session-🌿')
		runtime.runState = 'thinking'

		expect(isSessionExecutionPending(runtime)).toBe(false)

		runtime.processing = Promise.resolve()
		expect(isSessionExecutionPending(runtime)).toBe(true)
		runtime.processing = undefined

		runtime.manualCompressionAbortController = new AbortController()
		expect(isSessionExecutionPending(runtime)).toBe(true)
		runtime.manualCompressionAbortController = undefined

		enqueueUserSubmission(runtime, {
			text: '中性内容 🌿',
			userContext: [],
		})
		expect(isSessionExecutionPending(runtime)).toBe(true)
		claimNextTurn(runtime)
		expect(isSessionExecutionPending(runtime)).toBe(true)
	})

	it('replaces execution while preserving the draft when a session is rehydrated', () => {
		const state = new ChatState()
		const runtimeStates = new RuntimeStates(state)
		const runtime = runtimeStates.get('neutral-session')
		enqueueUserSubmission(runtime, {
			text: 'Hello 你好 🌿',
			userContext: [],
		})
		const active = claimNextTurn(runtime)!
		const manualCompression = new AbortController()
		runtime.manualCompressionAbortController = manualCompression
		runtime.draft = {
			text: '中性草稿 Hello 🌿',
			userContext: [
				{
					type: 'vault-path',
					hash: 'neutral-context',
					kind: 'file',
					path: '中性 🌿.md',
				},
			],
		}

		runtimeStates.resetExecution('neutral-session')
		const replacement = runtimeStates.get('neutral-session')

		expect(active.abortController.signal.aborted).toBe(true)
		expect(manualCompression.signal.aborted).toBe(true)
		expect(state.runtimeBySessionId.get('neutral-session')).toBe(replacement)
		expect(replacement).not.toBe(runtime)
		expect(replacement.scheduler.active).toBeUndefined()
		expect(replacement.draft).toEqual({
			text: '中性草稿 Hello 🌿',
			userContext: [
				{
					type: 'vault-path',
					hash: 'neutral-context',
					kind: 'file',
					path: '中性 🌿.md',
				},
			],
		})
	})
})
