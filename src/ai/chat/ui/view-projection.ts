import type { ChatSession } from '~/ai/chat/domain'
import { getMasterAgent, getSessionSubagents } from '~/ai/chat/domain'
import type { SessionRuntimeState } from '~/ai/chat/runtime/chat-state'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
import { projectTimelineMessageGroups } from '~/ai/chat/ui/display-blocks'
import type { ChatAgentView, ChatTimelineMessageItem } from '~/ai/chat/ui/types'

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

/**
 * The projection depends on these values only. Strings and objects are
 * replaced rather than mutated by the runtime, so identity comparison is a
 * sufficient change test and costs one pass over the parts.
 */
function fingerprintMessage(
	message: AppUIMessage,
	operations: ChatAgentState['operations'][string] | undefined,
	toolTimings: ChatAgentState['toolTimings'],
) {
	const fingerprint: unknown[] = [message.id, message.role, message.metadata]
	for (const part of message.parts) {
		const values = Object.values(part as Record<string, unknown>)
		fingerprint.push(values.length, ...values)
		if (part.type === 'dynamic-tool') {
			fingerprint.push(toolTimings[part.toolCallId])
		}
	}
	fingerprint.push(operations)
	return fingerprint
}

function matchesFingerprint(
	left: readonly unknown[],
	right: readonly unknown[],
) {
	if (left.length !== right.length) return false
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return false
	}
	return true
}

function buildProjectedItem(
	message: AppUIMessage,
	operations: ChatAgentState['operations'][string] | undefined,
	toolTimings: ChatAgentState['toolTimings'],
	fallbackCreatedAt: number,
): ChatTimelineMessageItem | undefined {
	const snapshotMessage = snapshotViewValue(message)
	const timings: ChatAgentState['toolTimings'] = {}
	for (const part of message.parts) {
		if (part.type !== 'dynamic-tool') continue
		const timing = toolTimings[part.toolCallId]
		if (timing) timings[part.toolCallId] = snapshotViewValue(timing)
	}
	const projected = projectTimelineMessageGroups(
		[snapshotMessage],
		timings,
		operations ? { [message.id]: snapshotViewValue(operations) } : {},
	)[0]
	if (!projected) return undefined
	return {
		createdAt: projected.message.metadata?.createdAt ?? fallbackCreatedAt,
		message: projected.message,
		displayBlocks: projected.blocks,
		showHeader: true,
	}
}

function applyShowHeaders(timeline: ChatTimelineMessageItem[]) {
	let previousModelId: string | undefined
	let canContinue = false
	let changed = false
	const next = timeline.map((item) => {
		let showHeader = true
		if (item.message.role === 'assistant') {
			const modelId = item.message.metadata?.llm?.modelId
			showHeader = !canContinue || !modelId || modelId !== previousModelId
			previousModelId = modelId
			canContinue = !!modelId
		} else if (item.message.role === 'user') {
			previousModelId = undefined
			canContinue = false
		}
		if (item.showHeader === showHeader) return item
		changed = true
		return { ...item, showHeader }
	})
	return changed ? next : timeline
}

interface ProjectedMessage {
	fingerprint: readonly unknown[]
	item?: ChatTimelineMessageItem
}

interface AgentProjection {
	order: readonly string[]
	messages: ReadonlyMap<string, ProjectedMessage>
	timeline: ChatTimelineMessageItem[]
	view?: ChatAgentView
	viewFingerprint?: readonly unknown[]
}

/**
 * Chat sessions are mutated in place during a run. This projector keeps the
 * detached view snapshots for unchanged messages, so a streamed delta clones
 * one message instead of the whole session and the view layer sees stable
 * references for everything else.
 */
export class ChatViewProjector {
	private readonly agents = new WeakMap<ChatAgentState, AgentProjection>()

	projectSession(session: ChatSession): {
		timeline: ChatTimelineMessageItem[]
		agentsById: Record<string, ChatAgentView>
	} {
		const timeline = this.projectAgent(
			getMasterAgent(session),
			session.createdAt,
		).timeline
		const agentsById: Record<string, ChatAgentView> = {}
		for (const agent of getSessionSubagents(session)) {
			const projection = this.projectAgent(agent, agent.createdAt)
			const view = this.buildAgentView(agent, projection)
			if (view) agentsById[agent.id] = view
		}
		return { timeline, agentsById }
	}

	private projectAgent(
		agent: ChatAgentState,
		fallbackCreatedAt: number,
	): AgentProjection {
		const previous = this.agents.get(agent)
		const messages = new Map<string, ProjectedMessage>()
		const order: string[] = []
		const timeline: ChatTimelineMessageItem[] = []
		let changed = !previous

		for (const message of [...agent.timeline, ...agent.pendingInputs]) {
			order.push(message.id)
			const operations = agent.operations[message.id]
			const fingerprint = fingerprintMessage(
				message,
				operations,
				agent.toolTimings,
			)
			const cached = previous?.messages.get(message.id)
			if (cached && matchesFingerprint(cached.fingerprint, fingerprint)) {
				messages.set(message.id, cached)
				if (cached.item) timeline.push(cached.item)
				continue
			}
			changed = true
			const item = buildProjectedItem(
				message,
				operations,
				agent.toolTimings,
				fallbackCreatedAt,
			)
			const projected: ProjectedMessage = { fingerprint, item }
			messages.set(message.id, projected)
			if (item) timeline.push(item)
		}

		const sameOrder =
			previous?.order.length === order.length &&
			previous.order.every((id, index) => id === order[index])
		if (previous && !changed && sameOrder) return previous

		const headedTimeline = applyShowHeaders(timeline)
		for (const item of headedTimeline) {
			const projected = messages.get(item.message.id)
			if (projected && projected.item !== item) projected.item = item
		}

		const projection: AgentProjection = {
			order,
			messages,
			timeline: headedTimeline,
			view: previous?.view,
			viewFingerprint: previous?.viewFingerprint,
		}
		this.agents.set(agent, projection)
		return projection
	}

	private buildAgentView(
		agent: ChatAgentState,
		projection: AgentProjection,
	): ChatAgentView | undefined {
		const fingerprint = [
			agent.id,
			agent.type,
			agent.status,
			agent.createdAt,
			agent.startedAt,
			agent.finishedAt,
			projection.timeline,
		]
		if (
			projection.view &&
			projection.viewFingerprint &&
			matchesFingerprint(projection.viewFingerprint, fingerprint)
		) {
			return projection.view
		}
		const view: ChatAgentView = {
			id: agent.id,
			type: agent.type,
			status: agent.status,
			createdAt: agent.createdAt,
			startedAt: agent.startedAt,
			finishedAt: agent.finishedAt,
			timeline: projection.timeline,
		}
		projection.view = view
		projection.viewFingerprint = fingerprint
		return view
	}
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
					(agent) =>
						agent.status === 'running' ||
						agent.status === 'queued' ||
						agent.status === 'waiting',
				)
			)
		})
		.map((session) => session.id)
}
