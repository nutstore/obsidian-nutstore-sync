import type { AIMessageRecord, AISession, AITaskRecord } from '~/ai/core/types'
import {
	ChatSessionIndexItem,
	cloneMessage,
	cloneSession,
	mutateTaskRecord,
	toCancelledTask,
} from '~/ai/chat/domain'
import {
	deriveTitle,
	migrateMessageFromV0,
	needsV0Migration,
} from '~/ai/chat/messages/message-utils'
import {
	CHAT_INDEX_KEY,
	CHAT_META_KEY,
	INTERRUPTED_TASK_CANCEL_REASON,
} from '~/ai/chat/prompts'
import { normalizeReversibleToolOpRecord } from '~/ai/chat/messages/reversible-op-utils'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import type { Selection } from '~/ai/chat/runtime/selection'
import i18n from '~/i18n'
import { chatMetaKV, chatSessionKV, type ChatMetaRecord } from '~/storage'
import createId from '~/utils/create-id'

export class SessionStore {
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

		const { session, changed } = this.rehydrateSession(stored)
		this.state.loadedSessions.set(sessionId, session)
		const runtime = this.runtimeStates.get(sessionId)
		runtime.pendingMessages = []
		this.upsertSessionIndexItem(session, deriveTitle(session))
		if (changed) {
			await this.persistSession(session)
			await this.persistMetaAndIndex()
		}
		return session
	}

	async persistSession(session: AISession) {
		if (this.state.deletedSessionIds.has(session.id)) {
			return
		}
		await chatSessionKV.set(session.id, cloneSession(session))
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

	rehydrateSession(session: AISession) {
		const rehydrated = this.normalizeSession(session)
		let changed = this.selection.sanitizeSessionSelection(rehydrated)

		for (const task of rehydrated.tasks) {
			if (task.status !== 'queued' && task.status !== 'running') {
				continue
			}
			mutateTaskRecord(
				task,
				toCancelledTask(
					task,
					INTERRUPTED_TASK_CANCEL_REASON,
					Date.now(),
					i18n.t('chatbox.task.cancelledSummary', { task: task.title }),
				),
			)
			changed = true
		}

		return {
			session: rehydrated,
			changed,
		}
	}

	normalizeSession(session: AISession): AISession {
		const normalized: AISession = {
			id: session.id,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt || session.createdAt,
			model: session.model ? { ...session.model } : undefined,
			systemPrompt: session.systemPrompt,
			inferenceParams: session.inferenceParams
				? { ...session.inferenceParams }
				: undefined,
			fragments:
				Array.isArray(session.fragments) && session.fragments.length > 0
					? session.fragments.map((fragment) => ({
							id: fragment.id,
							createdAt: fragment.createdAt,
							updatedAt: fragment.updatedAt || fragment.createdAt,
							summary: fragment.summary,
							messages: Array.isArray(fragment.messages)
								? fragment.messages.map((message) => ({
										...message,
										reversibleOps: Array.isArray(message.reversibleOps)
											? message.reversibleOps
													.filter(
														(op) =>
															!!op &&
															typeof op.vaultPath === 'string' &&
															(op.operation === 'create' ||
																op.operation === 'update' ||
																op.operation === 'delete') &&
															!!op.before &&
															(op.before.kind === 'file' ||
																op.before.kind === 'dir') &&
															(op.operation !== 'update' ||
																op.before.kind === 'file'),
													)
													.map(normalizeReversibleToolOpRecord)
													.filter(
														(
															op,
														): op is NonNullable<
															AIMessageRecord['reversibleOps']
														>[number] => !!op,
													)
											: undefined,
										message: cloneMessage(
											needsV0Migration(message.message)
												? migrateMessageFromV0(message.message)
												: message.message,
										),
										meta: message.meta
											? {
													...message.meta,
													usage: message.meta.usage
														? {
																...message.meta.usage,
															}
														: undefined,
												}
											: undefined,
									}))
								: [],
						}))
					: [
							{
								id: createId('fragment'),
								createdAt: Date.now(),
								updatedAt: Date.now(),
								messages: [],
							},
						],
			activeFragmentId: session.activeFragmentId,
			tasks: Array.isArray(session.tasks)
				? session.tasks.map((task: AITaskRecord) => ({ ...task }))
				: [],
		}

		if (
			!normalized.fragments.some(
				(item) => item.id === normalized.activeFragmentId,
			)
		) {
			normalized.activeFragmentId =
				normalized.fragments[normalized.fragments.length - 1].id
		}
		return normalized
	}

	isChatMetaRecord(value: unknown): value is ChatMetaRecord {
		return (
			!!value &&
			typeof value === 'object' &&
			Array.isArray((value as ChatMetaRecord).orderedSessionIds)
		)
	}

	upsertSessionIndexItem(session: AISession, title?: string, prepend = false) {
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
