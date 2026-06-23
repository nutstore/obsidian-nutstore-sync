import type {
	ChatState,
	SessionRuntimeState,
} from '~/ai/chat/runtime/chat-state'

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
}
