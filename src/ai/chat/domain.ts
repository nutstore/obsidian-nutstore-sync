import type { LanguageModelUsage } from 'ai'
import type {
	AppUIMessage,
	ChatAgentState,
	ChatTodoItem,
	LegacyChatMessageRecord,
} from '~/ai/chat/types'

export interface ChatFragment {
	id: string
	createdAt: number
	updatedAt: number
	summary?: string
	messages: LegacyChatMessageRecord[]
	readVaultPaths?: string[]
}

interface ChatSessionBase {
	id: string
	createdAt: number
	updatedAt: number
	model?: { providerId: string; modelId: string }
	systemPrompt?: string
	/** MCP server names disabled for this session; undefined/empty means all enabled. */
	disabledMcpServers?: string[]
}

export interface LegacyChatSession extends ChatSessionBase {
	fragments: ChatFragment[]
	activeFragmentId: string
}

export interface ChatSession extends ChatSessionBase {
	schemaVersion: 2
	subagents: { master: ChatAgentState }
}

export interface ChatSessionIndexItem {
	id: string
	title: string
	createdAt: number
	updatedAt: number
}

export function resolveUsedContextTokens(usage?: LanguageModelUsage) {
	if (!usage) return 0
	if (typeof usage.totalTokens === 'number' && usage.totalTokens > 0) {
		return usage.totalTokens
	}
	return Math.max(0, (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))
}

export function getMasterAgent(session: ChatSession): ChatAgentState {
	return session.subagents.master
}

function getActiveTimeline(session: ChatSession): AppUIMessage[] {
	return getMasterAgent(session).timeline
}

function collectSubagents(agent: ChatAgentState): ChatAgentState[] {
	return Object.values(agent.subagents).flatMap((child) => [
		child,
		...collectSubagents(child),
	])
}

export function getSessionSubagents(session: ChatSession): ChatAgentState[] {
	return collectSubagents(getMasterAgent(session)).sort(
		(left, right) => right.createdAt - left.createdAt,
	)
}

export function findLatestTodos(session: ChatSession): ChatTodoItem[] {
	const timeline = getActiveTimeline(session)
	for (let i = timeline.length - 1; i >= 0; i -= 1) {
		const part = timeline[i]?.parts.find(
			(candidate) => candidate.type === 'data-todos',
		)
		if (part?.type === 'data-todos') {
			return part.data.items.map((todo) => ({
				...todo,
			}))
		}
	}
	return []
}

export function isTerminalAgent(agent: ChatAgentState) {
	return (
		agent.status === 'completed' ||
		agent.status === 'failed' ||
		agent.status === 'cancelled'
	)
}
