import type { ChatSubmission } from '~/ai/chat/types'
import type { UserContextItem } from '~/ai/chat/context/user-context'

export function hasQueuedSubmission(runtime: { pending: ChatSubmission[] }) {
	return runtime.pending.length > 0
}

export function enqueuePendingSubmission(
	currentPending: ChatSubmission[],
	draft: ChatSubmission,
	activeContextItems: UserContextItem[],
	dedupeUserContextItems: (items: UserContextItem[]) => UserContextItem[],
) {
	const text = draft.text.trim()
	const userContext = dedupeUserContextItems([
		...draft.userContext,
		...activeContextItems,
	])
	if (!text && userContext.length === 0) {
		return currentPending
	}
	return [...currentPending, { text, userContext }]
}
