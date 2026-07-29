import type { ChatSession, LegacyChatSession } from '~/ai/chat/domain'

import { ChatSessionIndexItem } from '~/ai/chat/domain'
import { deriveTitle } from '~/ai/chat/messages/message-utils'
import { CHAT_INDEX_KEY, CHAT_META_KEY } from '~/ai/chat/prompts'
import { normalizeReversibleToolOpRecord } from '~/ai/chat/messages/reversible-op-utils'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import type { Selection } from '~/ai/chat/runtime/selection'
import i18n from '~/i18n'
import { chatMetaKV, chatSessionKV, type ChatMetaRecord } from '~/storage'
import {
	decodeChatSessionFromStorage,
	encodeChatSessionForStorage,
} from '~/ai/chat/session/session-persistence'
import {
	migrateChatSession,
	normalizeLegacySession,
} from '~/ai/chat/session/session-migration'
import type { ChatAgentState } from '~/ai/chat/types'
import { getSessionSubagents } from '~/ai/chat/domain'
import { MASTER_AGENT_ID } from '~/ai/chat/agents/registry'

export class SessionStore {
	private persistQueues = new Map<string, Promise<void>>()

	constructor(
		private state: ChatState,
		private runtimeStates: RuntimeStates,
		private selection: Selection,
	) {}

	async loadSessionIndex() {
		const [metaRaw, indexRaw] = await Promise.all([
			chatMetaKV.get(CHAT_META_KEY),
			chatMetaKV.get(CHAT_INDEX_KEY),
		])
		const meta = this.isChatMetaRecord(metaRaw)
			? metaRaw
			: { orderedSessionIds: [] }
		const index = Array.isArray(indexRaw)
			? indexRaw.filter(
					(item): item is ChatSessionIndexItem =>
						!!item &&
						typeof item.id === 'string' &&
						typeof item.title === 'string' &&
						typeof item.createdAt === 'number' &&
						typeof item.updatedAt === 'number',
				)
			: []

		const indexById = new Map(index.map((item) => [item.id, item]))
		this.state.sessionIndex = meta.orderedSessionIds
			.map((sessionId) => indexById.get(sessionId))
			.filter((item): item is ChatSessionIndexItem => !!item)
		for (const item of index) {
			if (!meta.orderedSessionIds.includes(item.id)) {
				this.state.sessionIndex.push(item)
			}
		}
		this.state.activeSessionId = meta.activeSessionId
	}

	async loadSessionById(sessionId: string) {
		const cached = this.state.loadedSessions.get(sessionId)
		if (cached) {
			return cached
		}

		const stored = await chatSessionKV.get(sessionId)
		if (!stored) {
			throw new Error(i18n.t('chatbox.errors.sessionNotFound'))
		}

		const { session, changed } = this.rehydrateSession(
			decodeChatSessionFromStorage(stored),
		)
		this.state.loadedSessions.set(sessionId, session)
		const runtime = this.runtimeStates.get(sessionId)
		runtime.pending = []
		this.upsertSessionIndexItem(session, deriveTitle(session))
		if (changed) {
			await this.persistSession(session)
			await this.persistMetaAndIndex()
		}
		return session
	}

	async persistSession(session: ChatSession) {
		if (this.state.deletedSessionIds.has(session.id)) {
			return
		}
		const sessionId = session.id
		const previous = this.persistQueues.get(sessionId) ?? Promise.resolve()
		const write = Promise.all([
			previous.catch(() => undefined),
			encodeChatSessionForStorage(session),
		]).then(async ([, snapshot]) => {
			if (this.state.deletedSessionIds.has(sessionId)) return
			await chatSessionKV.set(sessionId, snapshot)
		})
		this.persistQueues.set(sessionId, write)
		void write
			.finally(() => {
				if (this.persistQueues.get(sessionId) === write) {
					this.persistQueues.delete(sessionId)
				}
			})
			.catch(() => undefined)
		await write
	}

	async persistMetaAndIndex() {
		const meta: ChatMetaRecord = {
			activeSessionId: this.state.activeSessionId,
			orderedSessionIds: this.state.sessionIndex.map((item) => item.id),
		}
		await Promise.all([
			chatMetaKV.set(CHAT_META_KEY, meta),
			chatMetaKV.set(
				CHAT_INDEX_KEY,
				this.state.sessionIndex.map((item) => ({ ...item })),
			),
		])
	}

	rehydrateSession(session: ChatSession | LegacyChatSession) {
		const migrated = migrateChatSession(
			'schemaVersion' in session ? session : normalizeLegacySession(session),
		)
		const rehydrated = this.normalizeSession(migrated.session)
		let changed =
			migrated.changed || this.selection.sanitizeSessionSelection(rehydrated)

		for (const agent of getSessionSubagents(rehydrated)) {
			if (agent.status !== 'queued' && agent.status !== 'running') {
				continue
			}
			agent.status = 'cancelled'
			agent.finishedAt = Date.now()
			changed = true
		}

		return {
			session: rehydrated,
			changed,
		}
	}

	normalizeSession(session: ChatSession): ChatSession {
		const normalizeMessage = (message: ChatAgentState['timeline'][number]) => ({
			...message,
			metadata: message.metadata
				? {
						...message.metadata,
						llm: message.metadata.llm ? { ...message.metadata.llm } : undefined,
					}
				: { createdAt: session.createdAt },
			parts: [...message.parts],
		})
		const normalizeAgent = (agent: ChatAgentState): ChatAgentState => {
			const normalizeTimestamp = (value: unknown) =>
				typeof value === 'number' && Number.isFinite(value) ? value : undefined
			const subagents = Object.fromEntries(
				Object.entries(agent.subagents ?? {}).map(([id, child]) => [
					id,
					normalizeAgent(child),
				]),
			)
			return {
				id: agent.id,
				type:
					agent.type ||
					(agent.id === MASTER_AGENT_ID ? MASTER_AGENT_ID : 'subagent'),
				status: agent.id === MASTER_AGENT_ID ? 'idle' : agent.status,
				createdAt: agent.createdAt || session.createdAt,
				startedAt: normalizeTimestamp(agent.startedAt),
				finishedAt: normalizeTimestamp(agent.finishedAt),
				timeline: Array.isArray(agent.timeline)
					? agent.timeline.map(normalizeMessage)
					: [],
				pendingInputs: Array.isArray(agent.pendingInputs)
					? agent.pendingInputs.map(normalizeMessage)
					: [],
				operations: Object.fromEntries(
					Object.entries(agent.operations ?? {}).map(
						([messageId, operations]) => [
							messageId,
							operations
								.map(normalizeReversibleToolOpRecord)
								.filter((op): op is NonNullable<typeof op> => !!op),
						],
					),
				),
				toolTimings: Object.fromEntries(
					Object.entries(agent.toolTimings ?? {}).flatMap(
						([toolCallId, timing]) => {
							const startedAt = normalizeTimestamp(timing?.startedAt)
							if (startedAt === undefined) return []
							const finishedAt = normalizeTimestamp(timing.finishedAt)
							return [
								[
									toolCallId,
									{
										startedAt,
										...(finishedAt === undefined ? {} : { finishedAt }),
									},
								],
							]
						},
					),
				),
				readVaultPaths: Array.isArray(agent.readVaultPaths)
					? agent.readVaultPaths.filter((path) => typeof path === 'string')
					: undefined,
				subagents,
			}
		}
		const master = normalizeAgent(session.subagents.master)
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
			disabledMcpServers: Array.isArray(session.disabledMcpServers)
				? session.disabledMcpServers.filter(
						(name): name is string => typeof name === 'string',
					)
				: undefined,
			subagents: { master },
		}
	}

	isChatMetaRecord(value: unknown): value is ChatMetaRecord {
		return (
			!!value &&
			typeof value === 'object' &&
			Array.isArray((value as ChatMetaRecord).orderedSessionIds)
		)
	}

	upsertSessionIndexItem(
		session: ChatSession,
		title?: string,
		prepend = false,
	) {
		if (this.state.deletedSessionIds.has(session.id)) {
			return
		}
		const existingTitle =
			this.state.sessionIndex.find((e) => e.id === session.id)?.title ??
			i18n.t('chatbox.newChat')
		const item: ChatSessionIndexItem = {
			id: session.id,
			title: title ?? existingTitle,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
		}
		const existingIndex = this.state.sessionIndex.findIndex(
			(entry) => entry.id === session.id,
		)
		if (existingIndex === -1) {
			this.state.sessionIndex = prepend
				? [item, ...this.state.sessionIndex]
				: [...this.state.sessionIndex, item]
			return
		}

		const nextIndex = this.state.sessionIndex.slice()
		nextIndex[existingIndex] = item
		if (prepend && existingIndex > 0) {
			nextIndex.splice(existingIndex, 1)
			nextIndex.unshift(item)
		}
		this.state.sessionIndex = nextIndex
	}
}
