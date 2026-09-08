import type { ChatSession } from '~/ai/chat/domain'
import { getSessionSubagents, isTerminalAgent } from '~/ai/chat/domain'
import { removeIncompleteToolCalls } from '~/ai/chat/messages/ui-message'

/** Runtime execution cannot resume from a persisted chat session. */
export function normalizeRehydratedExecution(session: ChatSession) {
	let changed = removeIncompleteToolCalls(session.subagents.master)
	for (const agent of getSessionSubagents(session)) {
		if (agent.pendingInputs.length > 0) {
			agent.pendingInputs = []
			changed = true
		}
		if (removeIncompleteToolCalls(agent)) changed = true
		if (!isTerminalAgent(agent)) {
			agent.status = 'cancelled'
			agent.finishedAt = Date.now()
			changed = true
		}
	}
	return changed
}
