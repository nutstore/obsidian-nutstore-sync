import type { ChatSession } from '~/ai/chat/domain'
import { getMasterAgent, getSessionSubagents } from '~/ai/chat/domain'
import type { SessionRuntimeState } from '~/ai/chat/runtime/chat-state'
import { projectTimelineMessageGroups } from '~/ai/chat/ui/display-blocks'
import type { ChatboxProps } from '~/ai/chat/ui/types'

// Solid stores attach reactive Symbol metadata to wrapped plain objects. Keep
// that metadata in the view layer instead of mutating the canonical session.
function snapshotViewValue<T>(
	value: T,
	seen = new WeakMap<object, unknown>(),
): T {
	if (!value || typeof value !== 'object') return value

	const source = value as object
	const existing = seen.get(source)
	if (existing) return existing as T

	if (Array.isArray(value)) {
		const snapshot: unknown[] = []
		seen.set(source, snapshot)
		for (const item of value) snapshot.push(snapshotViewValue(item, seen))
		return snapshot as T
	}

	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) return value

	const snapshot = Object.create(prototype) as Record<string, unknown>
	seen.set(source, snapshot)
	for (const [key, entry] of Object.entries(value)) {
		snapshot[key] = snapshotViewValue(entry, seen)
	}
	return snapshot as T
}

function buildAgentTimeline(
	agent: import('~/ai/chat/types').ChatAgentState,
	createdAt: number,
): ChatboxProps['timeline'] {
	const messages = snapshotViewValue(agent.timeline)
	const toolTimings = snapshotViewValue(agent.toolTimings)
	const operations = snapshotViewValue(agent.operations)
	const timeline = projectTimelineMessageGroups(
		messages,
		toolTimings,
		operations,
	).map(({ message, blocks }) => ({
		createdAt: message.metadata?.createdAt ?? createdAt,
		message,
		displayBlocks: blocks,
		showHeader: true,
	}))
	let previousModelId: string | undefined
	let canContinue = false
	for (const item of timeline) {
		if (item.message.role === 'user') {
			previousModelId = undefined
			canContinue = false
			continue
		}
		const modelId = item.message.metadata?.llm?.modelId
		item.showHeader = !canContinue || !modelId || modelId !== previousModelId
		previousModelId = modelId
		canContinue = !!modelId
	}
	return timeline
}

export function buildTimeline(session: ChatSession): ChatboxProps['timeline'] {
	return buildAgentTimeline(getMasterAgent(session), session.createdAt)
}

export function buildAgentViews(
	session: ChatSession,
): ChatboxProps['agentsById'] {
	const views: ChatboxProps['agentsById'] = {}
	const visit = (agent: import('~/ai/chat/types').ChatAgentState) => {
		for (const child of Object.values(agent.subagents)) {
			views[child.id] = {
				id: child.id,
				type: child.type,
				status: child.status,
				createdAt: child.createdAt,
				startedAt: child.startedAt,
				finishedAt: child.finishedAt,
				timeline: buildAgentTimeline(child, child.createdAt),
			}
			visit(child)
		}
	}
	visit(getMasterAgent(session))
	return views
}

export function collectOtherBusySessionIds(
	loadedSessions: Map<string, ChatSession>,
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
				runtime.scheduler.queued.length > 0 ||
				getSessionSubagents(session).some(
					(agent) => agent.status === 'running' || agent.status === 'queued',
				)
			)
		})
		.map((session) => session.id)
}
