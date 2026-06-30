import type { AIMessage, AIMessageRecord, AISession } from '~/ai/core/types'
import type { AssistantModelMessage, TextPart, ToolCallPart } from 'ai'
import type { ChatFragment } from '~/ai/chat/domain'
import {
	cloneUserContextItems,
	type UserContextItem,
} from '~/ai/chat/context/user-context'
import {
	captureWorkspaceContexts,
	computeChangedContexts,
} from '~/ai/chat/context/workspace-context'
import { messageToText, toTextParts } from '~/ai/chat/messages/message-utils'
import { normalizeReversibleToolOpRecord } from '~/ai/chat/messages/reversible-op-utils'
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import createId from '~/utils/create-id'
import logger from '~/utils/logger'
import type NutstorePlugin from '../../..'

export class MessageFactory {
	constructor(
		private plugin: NutstorePlugin,
		private runtimeStates: RuntimeStates,
		private notify: () => void,
	) {}

	createFragment(session: AISession): ChatFragment {
		const now = Date.now()
		const fragment: ChatFragment = {
			id: createId('fragment'),
			createdAt: now,
			updatedAt: now,
			messages: [],
		}
		session.fragments = [...session.fragments, fragment]
		session.activeFragmentId = fragment.id
		return fragment
	}

	getActiveFragment(session: AISession) {
		return (
			session.fragments.find((item) => item.id === session.activeFragmentId) ||
			session.fragments[session.fragments.length - 1]
		)
	}

	createMessageRecord(
		message: AIMessage,
		options?: {
			meta?: AIMessageRecord['meta']
			isError?: boolean
			reversibleOps?: AIMessageRecord['reversibleOps']
			todos?: AIMessageRecord['todos']
		},
	): AIMessageRecord {
		return {
			id: createId('message'),
			createdAt: Date.now(),
			message,
			meta: options?.meta,
			isError: options?.isError,
			reversibleOps: options?.reversibleOps
				?.map(normalizeReversibleToolOpRecord)
				.filter(
					(op): op is NonNullable<AIMessageRecord['reversibleOps']>[number] =>
						!!op,
				),
			todos: options?.todos?.map((todo) => ({ ...todo })),
		}
	}

	appendUserMessage(
		fragment: ChatFragment,
		text: string,
		session?: AISession,
		userContext?: UserContextItem[],
	) {
		const now = Date.now()
		fragment.updatedAt = now
		if (session) {
			session.updatedAt = now
		}
		const current = captureWorkspaceContexts(this.plugin.app)
		const changed = computeChangedContexts(fragment.messages, current)
		const content: TextPart[] = []
		if (text) {
			content.push(...toTextParts(text))
		}
		const record = this.createMessageRecord({
			role: 'user',
			content,
		})
		if (changed.length > 0) {
			record.workspaceContextDelta = changed
		}
		if (userContext && userContext.length > 0) {
			record.userContext = cloneUserContextItems(userContext)
		}
		fragment.messages.push(record)
	}

	removeUnmatchedToolCalls(fragment: ChatFragment) {
		const resolvedToolCallIds = new Set(
			fragment.messages.flatMap((item) => {
				if (
					item.message.role !== 'tool' ||
					!Array.isArray(item.message.content)
				) {
					return []
				}
				const part = (
					item.message.content as Array<{ type: string; toolCallId?: string }>
				)[0]
				return part?.type === 'tool-result' && part.toolCallId
					? [part.toolCallId]
					: []
			}),
		)

		fragment.messages = fragment.messages.filter((record) => {
			if (
				record.message.role !== 'assistant' ||
				!Array.isArray(record.message.content)
			) {
				return true
			}
			const content = record.message.content as Array<
				{ type: string } & Partial<ToolCallPart>
			>
			const toolCalls = content.filter(
				(p): p is ToolCallPart => p.type === 'tool-call',
			)
			if (toolCalls.length === 0) {
				return true
			}

			const nextToolCalls = toolCalls.filter((tc) =>
				resolvedToolCallIds.has(tc.toolCallId),
			)
			const nonToolParts = content.filter((p) => p.type !== 'tool-call')
			const hasText = !!messageToText(record.message).trim()
			if (!hasText && nextToolCalls.length === 0) {
				return false
			}

			record.message = {
				...record.message,
				content: [...nonToolParts, ...nextToolCalls],
			} as AssistantModelMessage
			return true
		})
	}

	finishStoppedSessionRun(session: AISession, fragment: ChatFragment) {
		const runtime = this.runtimeStates.get(session.id)
		this.removeUnmatchedToolCalls(fragment)
		runtime.stopRequested = false
		runtime.runState = 'idle'
		this.notify()
	}

	reportFatalError(
		session: AISession,
		message: string,
		meta?: AIMessageRecord['meta'],
		fragment: ChatFragment = this.getActiveFragment(session),
	) {
		logger.error(message)
		fragment.messages.push(
			this.createMessageRecord(
				{
					role: 'assistant',
					content: toTextParts(message),
				},
				{ meta, isError: true },
			),
		)
		this.notify()
	}
}
