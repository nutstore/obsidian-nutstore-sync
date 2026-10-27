import type { ChatSession } from '~/ai/chat/domain'
import { getSessionSubagents, isTerminalAgent } from '~/ai/chat/domain'
import { removeIncompleteToolCalls } from '~/ai/chat/messages/ui-message'

/** Runtime execution cannot resume from a persisted chat session. */
export function normalizeRehydratedExecution(session: ChatSession) {
	let changed = removeIncompleteToolCalls(session.subagents.master)
	for (const agent of getSessionSubagents(session)) {
		if (removeIncompleteToolCalls(agent)) changed = true
		if (!isTerminalAgent(agent)) {
			agent.status = 'cancelled'
			agent.finishedAt = Date.now()
			const execution = agent.executions?.find(
				(run) => run.id === agent.executionId,
			)
			if (execution && !execution.status) {
				execution.status = 'cancelled'
				execution.finishedAt = agent.finishedAt
			}
			changed = true
		}
	}
	return changed
}
