import type {
	ChatState,
	SessionRuntimeState,
} from '~/ai/chat/runtime/chat-state'
import { createMasterTurnScheduler } from '~/ai/chat/runtime/master-turn-scheduler'

export class RuntimeStates {
	constructor(private state: ChatState) {}

	get(sessionId: string): SessionRuntimeState {
		let runtime = this.state.runtimeBySessionId.get(sessionId)
		if (!runtime) {
			runtime = {
				runState: 'idle',
				draft: {
					text: '',
					userContext: [],
				},
				scheduler: createMasterTurnScheduler(),
			}
			this.state.runtimeBySessionId.set(sessionId, runtime)
		}
		return runtime
	}

	/** Runtime execution never survives a session rehydration. */
	resetExecution(sessionId: string) {
		const previous = this.state.runtimeBySessionId.get(sessionId)
		if (!previous) return
		previous.scheduler.active?.abortController.abort()
		previous.manualCompressionAbortController?.abort()
		this.state.runtimeBySessionId.set(sessionId, {
			runState: 'idle',
			draft: {
				text: previous.draft.text,
				userContext: previous.draft.userContext.slice(),
			},
			scheduler: createMasterTurnScheduler(),
		})
	}

	getAutoApproveRequests(sessionId: string) {
		let requests = this.state.autoApproveRequestsBySessionId.get(sessionId)
		if (!requests) {
			requests = new Set<string>()
			this.state.autoApproveRequestsBySessionId.set(sessionId, requests)
		}
		return requests
	}
}

/** `runState` is a UI projection, not an execution ownership signal. */
export function isSessionExecutionPending(runtime: SessionRuntimeState) {
	return Boolean(
		runtime.processing ||
		runtime.manualCompressionAbortController ||
		runtime.scheduler.active ||
		runtime.scheduler.queued.length > 0,
	)
}
