import type { AISession } from '~/ai/core/types'
import { cloneMessageRecord } from '~/ai/chat/domain'
import { hasQueuedSubmission } from '~/ai/chat/runtime/pending-submission'
import { projectFragmentMessageGroups } from '~/ai/chat/ui/display-blocks'
import type { SessionRuntimeState } from '~/ai/chat/runtime/chat-state'
import type { ChatboxProps } from '~/ai/chat/ui/types'

export function buildTimeline(session: AISession): ChatboxProps['timeline'] {
	const timeline = session.fragments.flatMap((fragment) => {
		const items = projectFragmentMessageGroups(fragment.messages).map(
			({ record, blocks }) => ({
				id: `message:${record.id}`,
				kind: 'message' as const,
				createdAt: record.createdAt,
				message: cloneMessageRecord(record),
				displayBlocks: blocks,
				showHeader: true,
			}),
		)

		return [
			{
				id: `fragment:${fragment.id}`,
				kind: 'fragment' as const,
				createdAt: fragment.createdAt,
			},
			...items,
		]
	})

	let activeAgentModelId: string | undefined
	let previousAgentModelId: string | undefined
	let canContinueAgentGroup = false

	for (const item of timeline) {
		if (item.kind === 'fragment') {
			activeAgentModelId = undefined
			previousAgentModelId = undefined
			canContinueAgentGroup = false
			continue
		}

		const role = item.message.message.role
		if (role === 'user') {
			item.showHeader = true
			activeAgentModelId = undefined
			previousAgentModelId = undefined
			canContinueAgentGroup = false
			continue
		}

		if (role !== 'assistant' && role !== 'tool') {
			item.showHeader = true
			activeAgentModelId = undefined
			previousAgentModelId = undefined
			canContinueAgentGroup = false
			continue
		}

		const effectiveModelId =
			role === 'assistant' ? item.message.meta?.modelId : activeAgentModelId
		const showHeader =
			!canContinueAgentGroup ||
			!effectiveModelId ||
			effectiveModelId !== previousAgentModelId

		item.showHeader = showHeader
		activeAgentModelId =
			role === 'assistant' ? effectiveModelId : activeAgentModelId
		previousAgentModelId = effectiveModelId
		canContinueAgentGroup = !!effectiveModelId
	}

	return timeline
}

export function collectOtherSessionTasks(
	loadedSessions: Map<string, AISession>,
	activeSessionId: string | undefined,
) {
	return Array.from(loadedSessions.values())
		.filter((session) => session.id !== activeSessionId)
		.flatMap((session) => session.tasks)
		.sort((left, right) => right.createdAt - left.createdAt)
}

export function collectOtherBusySessionIds(
	loadedSessions: Map<string, AISession>,
	activeSessionId: string | undefined,
	getRuntime: (sessionId: string) => SessionRuntimeState,
) {
	return Array.from(loadedSessions.values())
		.filter((session) => session.id !== activeSessionId)
		.filter((session) => {
			const runtime = getRuntime(session.id)
			return (
				runtime.runState !== 'idle' ||
				!!runtime.processing ||
				hasQueuedSubmission(runtime)
			)
		})
		.map((session) => session.id)
}
