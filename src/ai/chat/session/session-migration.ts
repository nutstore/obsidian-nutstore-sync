import type { ChatAgentState, LegacyChatMessageRecord } from '~/ai/chat/types'
import type {
	ChatFragment,
	ChatSession,
	LegacyChatSession,
} from '~/ai/chat/domain'
import {
	createEmptyMasterAgent,
	getMessageText,
	mergeLegacyToolRecord,
	modelMessageToUIMessage,
} from '~/ai/chat/messages/ui-message'
function isV2Session(value: unknown): value is ChatSession {
	return (
		!!value &&
		typeof value === 'object' &&
		(value as { schemaVersion?: unknown }).schemaVersion === 2 &&
		!!(value as { subagents?: { master?: unknown } }).subagents?.master
	)
}

function appendLegacyRecord(
	agent: ChatAgentState,
	record: LegacyChatMessageRecord,
) {
	if (record.message.role === 'tool') {
		mergeLegacyToolRecord(agent.timeline, record, agent.operations)
		return
	}
	const message = modelMessageToUIMessage(record.message, {
		id: record.id,
		createdAt: record.createdAt,
		meta: record.meta,
		isError: record.isError,
		workspaceContextDelta: record.workspaceContextDelta,
		userContext: record.userContext,
		todos: record.todos,
	})
	agent.timeline.push(message)
	if (record.reversibleOps?.length) {
		agent.operations[message.id] = record.reversibleOps
	}
}

function appendFragment(
	agent: ChatAgentState,
	fragment: ChatFragment,
	fragmentIndex: number,
) {
	let records = Array.isArray(fragment.messages) ? fragment.messages : []
	if (fragmentIndex > 0) {
		const mode = fragment.summary ? 'summary' : 'reset'
		agent.timeline.push({
			id: `checkpoint-${fragment.id}`,
			role: 'user',
			metadata: {
				createdAt: fragment.createdAt,
			},
			parts: [
				{
					type: 'data-context-checkpoint',
					data: {
						mode,
						...(fragment.summary ? { summary: fragment.summary } : {}),
					},
				},
			],
		})

		// V1 compression stored the same summary both on the fragment and as its
		// first synthetic user message. The checkpoint replaces that duplicate.
		if (fragment.summary && records[0]?.message.role === 'user') {
			const first = modelMessageToUIMessage(records[0].message, {
				id: records[0].id,
				createdAt: records[0].createdAt,
			})
			if (getMessageText(first).trim() === fragment.summary.trim()) {
				records = records.slice(1)
			}
		}
	}

	for (const record of records) appendLegacyRecord(agent, record)
	if (fragment.readVaultPaths?.length) {
		agent.readVaultPaths = Array.from(
			new Set([...(agent.readVaultPaths ?? []), ...fragment.readVaultPaths]),
		)
	}
}

export function migrateLegacySession(session: LegacyChatSession): ChatSession {
	const master = createEmptyMasterAgent(session.createdAt)
	for (const [index, fragment] of (session.fragments ?? []).entries()) {
		appendFragment(master, fragment, index)
	}
	// Legacy tasks are intentionally not migrated. Their persisted records cannot
	// resume in the agent runtime and retaining them would only preserve inert
	// implementation history in every subsequently saved V2 session.
	return {
		schemaVersion: 2,
		id: session.id,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt || session.createdAt,
		model: session.model ? { ...session.model } : undefined,
		systemPrompt: session.systemPrompt,
		inferenceParams: session.inferenceParams
			? { ...session.inferenceParams }
			: undefined,
		subagents: { master },
	}
}

export function migrateChatSession(value: unknown): {
	session: ChatSession
	changed: boolean
} {
	if (isV2Session(value)) return { session: value, changed: false }
	return {
		session: migrateLegacySession(value as LegacyChatSession),
		changed: true,
	}
}
