import type {
	ChatState,
	SessionRuntimeState,
} from '~/ai/chat/runtime/chat-state'
import { createAbortError } from '~/ai/transport/abort'

export class RuntimeStates {
	constructor(private state: ChatState) {}

	get(sessionId: string): SessionRuntimeState {
		let runtime = this.state.runtimeBySessionId.get(sessionId)
		if (!runtime) {
			runtime = {
				runState: 'idle',
				pendingMessages: [],
				pendingUserContext: [],
				pendingInputDraft: '',
			}
			this.state.runtimeBySessionId.set(sessionId, runtime)
		}
		return runtime
	}

	getAutoApproveRequests(sessionId: string) {
		let requests = this.state.autoApproveRequestsBySessionId.get(sessionId)
		if (!requests) {
			requests = new Set<string>()
			this.state.autoApproveRequestsBySessionId.set(sessionId, requests)
		}
		return requests
	}

	createAbortController(sessionId: string) {
		const runtime = this.get(sessionId)
		const controller = new AbortController()
		runtime.abortController = controller
		return controller
	}

	clearAbortController(sessionId: string, controller?: AbortController) {
		const runtime = this.get(sessionId)
		if (!controller || runtime.abortController === controller) {
			runtime.abortController = undefined
		}
	}

	abortActiveRequest(sessionId: string, reason?: string) {
		const runtime = this.get(sessionId)
		runtime.abortController?.abort(createAbortError(reason || 'Aborted'))
	}
}
