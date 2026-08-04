import { Notice } from 'obsidian'
import type { ChatSession, LegacyChatSession } from '~/ai/chat/domain'

import { ChatSessionIndexItem } from '~/ai/chat/domain'
import { deriveTitle } from '~/ai/chat/messages/message-utils'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import type { Selection } from '~/ai/chat/runtime/selection'
import type { ChatMetaRecord } from '~/storage'
import {
	SessionFileCorruptError,
	SessionsFileBackend,
	type ChatMetaFile,
	type ChatSessionFilePayload,
} from '~/ai/chat/session/session-files'
import i18n from '~/i18n'
import {
	convertPersistedChatSessionToBase64,
	decodeChatSessionFromStorage,
	encodeChatSessionForStorage,
	type PersistedChatSession,
} from '~/ai/chat/session/session-persistence'
import {
	migrateChatSession,
	normalizeLegacySession,
} from '~/ai/chat/session/session-migration'
import type { ChatAgentState } from '~/ai/chat/types'
import { getSessionSubagents } from '~/ai/chat/domain'
import { normalizeReversibleToolOpRecord } from '~/ai/chat/messages/reversible-op-utils'
import { MASTER_AGENT_ID } from '~/ai/chat/agents/registry'
import logger from '~/utils/logger'

/**
 * Optional access to the legacy IndexedDB-backed session storage. Used once to
 * migrate existing sessions into vault JSON files and as a read fallback for
 * sessions whose file is not present on disk. Kept behind an interface so the
 * store stays testable without a live IndexedDB.
 */
export interface SessionLegacyStore {
	listSessionKeys(): Promise<string[]>
	getSession(id: string): Promise<unknown | undefined>
	unsetSession(id: string): Promise<void>
	getMeta(): Promise<{
		meta: ChatMetaRecord | null
		index: ChatSessionIndexItem[]
	}>
}

interface LegacyMigrationResult {
	meta: ChatMetaRecord | null
	index: ChatSessionIndexItem[]
	migrated: boolean
}

export class SessionStore {
	private persistQueues = new Map<string, Promise<void>>()

	constructor(
		private state: ChatState,
		private runtimeStates: RuntimeStates,
		private selection: Selection,
		private backend: SessionsFileBackend,
		private legacy: SessionLegacyStore,
	) {}

	async loadSessionIndex() {
		const legacyMigration = await this.ensureMigratedFromLegacy()
		await this.reconcileSessionIndex(legacyMigration)
	}

	/** Incrementally migrates IndexedDB sessions missing from vault storage. */
	private async ensureMigratedFromLegacy(): Promise<LegacyMigrationResult | null> {
		let keys: string[]
		try {
			keys = await this.legacy.listSessionKeys()
		} catch {
			return null
		}
		if (keys.length === 0) {
			return null
		}
		let meta = {
			meta: null as ChatMetaRecord | null,
			index: [] as ChatSessionIndexItem[],
		}
		try {
			meta = await this.legacy.getMeta()
		} catch {
			/* keep defaults */
		}
		const diskIds = new Set(await this.backend.listSessionIds())
		let migrated = false
		for (const key of keys) {
			if (diskIds.has(key)) {
				continue
			}
			let stored: unknown
			try {
				stored = await this.legacy.getSession(key)
			} catch {
				stored = undefined
			}
			if (!stored || typeof stored !== 'object') {
				continue
			}
			try {
				const session = convertPersistedChatSessionToBase64(
					stored as PersistedChatSession,
				)
				const item = meta.index.find((entry) => entry.id === key)
				await this.backend.writeSessionFile(key, {
					session,
					title: item?.title,
				})
				migrated = true
			} catch (error) {
				logger.warn(`Failed to migrate chat session ${key}, skipping it`, error)
			}
		}
		return { ...meta, migrated }
	}

	private async reconcileSessionIndex(
		legacyMigration: LegacyMigrationResult | null,
	) {
		const diskIds = new Set(await this.backend.listSessionIds())
		const meta = await this.backend.readMetaFile()
		const validItems = new Map<string, ChatSessionIndexItem>()
		for (const id of diskIds) {
			try {
				const payload = await this.backend.readSessionFile(id)
				const stored = decodeChatSessionFromStorage(payload.session)
				const { session } = this.rehydrateSession(stored)
				const cached = meta?.sessions?.[id]
				validItems.set(id, {
					id,
					title: payload.title || cached?.title || i18n.t('chatbox.newChat'),
					createdAt: cached?.createdAt ?? numberOrZero(session.createdAt),
					updatedAt: cached?.updatedAt ?? numberOrZero(session.updatedAt),
				})
			} catch {
				/* skip corrupt session files */
			}
		}

		const legacyOrder =
			legacyMigration?.meta?.orderedSessionIds ??
			legacyMigration?.index.map((item) => item.id) ??
			[]
		const preferredOrders =
			legacyMigration?.migrated || !meta
				? [legacyOrder, meta?.orderedSessionIds ?? []]
				: [meta.orderedSessionIds, legacyOrder]
		const items: ChatSessionIndexItem[] = []
		const indexedIds = new Set<string>()
		for (const id of [...preferredOrders.flat(), ...diskIds]) {
			const item = validItems.get(id)
			if (!item || indexedIds.has(id)) {
				continue
			}
			items.push(item)
			indexedIds.add(id)
		}

		this.state.sessionIndex = items
		const preferredActive =
			legacyMigration?.migrated || !meta
				? [legacyMigration?.meta?.activeSessionId, meta?.activeSessionId]
				: [meta.activeSessionId, legacyMigration?.meta?.activeSessionId]
		this.state.activeSessionId =
			preferredActive.find((id): id is string => !!id && validItems.has(id)) ??
			items[0]?.id
		await this.persistMetaAndIndex()
	}

	async loadSessionById(sessionId: string) {
		const cached = this.state.loadedSessions.get(sessionId)
		if (cached) {
			return cached
		}

		let payload: ChatSessionFilePayload | undefined
		try {
			payload = await this.backend.readSessionFile(sessionId)
		} catch (error) {
			if (error instanceof SessionFileCorruptError) {
				new Notice(
					i18n.t('chatbox.errors.corruptSessionFile', {
						path: error.filePath,
					}),
					10000,
				)
				throw new Error(i18n.t('chatbox.errors.sessionNotFound'), {
					cause: error,
				})
			}
			payload = undefined
		}

		let stored: ChatSession | LegacyChatSession | undefined
		let embeddedTitle: string | undefined
		if (payload) {
			stored = decodeChatSessionFromStorage(payload.session)
			embeddedTitle = payload.title
		} else {
			try {
				const legacy = await this.legacy.getSession(sessionId)
				if (legacy && typeof legacy === 'object') {
					stored = decodeChatSessionFromStorage(legacy as PersistedChatSession)
				}
			} catch {
				/* missing/unavailable legacy record */
			}
		}
		if (!stored) {
			throw new Error(i18n.t('chatbox.errors.sessionNotFound'))
		}

		const { session, changed } = this.rehydrateSession(stored)
		this.state.loadedSessions.set(sessionId, session)
		const runtime = this.runtimeStates.get(sessionId)
		runtime.pending = []

		const existing = this.state.sessionIndex.find(
			(item) => item.id === sessionId,
		)
		const freshTitle =
			embeddedTitle && embeddedTitle !== i18n.t('chatbox.newChat')
				? embeddedTitle
				: existing?.title && existing.title !== i18n.t('chatbox.newChat')
					? existing.title
					: deriveTitle(session)
		this.upsertSessionIndexItem(session, freshTitle)

		if (changed || !payload || !embeddedTitle) {
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
		const title = this.getIndexedTitle(session)
		const write = previous
			.catch(() => undefined)
			.then(async () => {
				if (this.state.deletedSessionIds.has(sessionId)) return
				const snapshot = await encodeChatSessionForStorage(session)
				if (this.state.deletedSessionIds.has(sessionId)) return
				await this.backend.writeSessionFile(sessionId, {
					session: snapshot,
					title,
				})
			})
		this.persistQueues.set(sessionId, write)
		void write
			.finally(() => {
				if (this.persistQueues.get(sessionId) === write) {
					this.persistQueues.delete(sessionId)
				}
			})
			.catch((error) => {
				logger.error('Failed to persist chat session', error)
			})
		await write
	}

	async persistMetaAndIndex() {
		const sessions: ChatMetaFile['sessions'] = {}
		for (const item of this.state.sessionIndex) {
			sessions[item.id] = {
				title: item.title,
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
			}
		}
		const meta: ChatMetaFile = {
			activeSessionId: this.state.activeSessionId,
			orderedSessionIds: this.state.sessionIndex.map((item) => item.id),
			sessions,
		}
		await this.backend.writeMetaFile(meta)
	}

	async deleteSession(sessionId: string) {
		this.state.deletedSessionIds.add(sessionId)
		await this.persistQueues.get(sessionId)?.catch(() => undefined)
		await this.backend.deleteSessionFile(sessionId)
		try {
			await this.legacy.unsetSession(sessionId)
		} catch {
			/* best-effort legacy cleanup */
		}
	}

	private getIndexedTitle(session: ChatSession): string | undefined {
		const title = this.state.sessionIndex.find(
			(item) => item.id === session.id,
		)?.title
		if (title && title !== i18n.t('chatbox.newChat')) {
			return title
		}
		return undefined
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

function numberOrZero(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
