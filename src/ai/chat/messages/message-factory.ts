import type { DynamicToolUIPart, ModelMessage } from 'ai'
import type { ChatSession } from '~/ai/chat/domain'
import { getMasterAgent } from '~/ai/chat/domain'
import type {
	AppUIMessage,
	ChatAgentState,
	ChatMessageMeta,
	ChatTodoItem,
	ReversibleToolOp,
} from '~/ai/chat/types'
import {
	copyUserContextItems,
	type UserContextItem,
} from '~/ai/chat/context/user-context'
import {
	captureWorkspaceContexts,
	computeChangedContexts,
} from '~/ai/chat/context/workspace-context'
import { normalizeReversibleToolOpRecord } from '~/ai/chat/messages/reversible-op-utils'
import createId from '~/utils/create-id'
import logger from '~/utils/logger'
import type { SkillRepository } from '~/ai/skills/repository'
import type { App } from 'obsidian'
import {
	modelMessageToUIMessage,
	removeIncompleteToolCalls,
} from '~/ai/chat/messages/ui-message'

export class MessageFactory {
	constructor(
		private app: App,
		private notify: () => void,
		private skillRepository?: SkillRepository,
	) {}

	getActiveAgent(session: ChatSession) {
		return getMasterAgent(session)
	}

	appendContextBoundary(
		session: ChatSession,
		agent: ChatAgentState,
		checkpoint: {
			mode: 'summary' | 'reset'
			summary?: string
			summarizedThroughMessageId?: string
			retainedMessageIds?: string[]
			preservedTurnCount?: number
		},
	) {
		const now = Date.now()
		agent.timeline.push({
			id: createId('checkpoint'),
			role: 'user',
			metadata: {
				createdAt: now,
			},
			parts: [
				{
					type: 'data-context-checkpoint',
					data: checkpoint,
				},
			],
		})
		agent.readVaultPaths = []
		session.updatedAt = now
		return agent
	}

	createMessage(
		message: ModelMessage,
		options?: {
			meta?: ChatMessageMeta
			isError?: boolean
			reversibleOps?: ReversibleToolOp[]
			todos?: ChatTodoItem[]
		},
	): AppUIMessage {
		return modelMessageToUIMessage(message, {
			id: createId('message'),
			createdAt: Date.now(),
			meta: options?.meta,
			isError: options?.isError,
			todos: options?.todos,
		})
	}

	setMessageOperations(
		agent: ChatAgentState,
		messageId: string,
		operations?: ReversibleToolOp[],
	) {
		const normalized = operations
			?.map(normalizeReversibleToolOpRecord)
			.filter((op): op is ReversibleToolOp => !!op)
		if (normalized?.length) {
			agent.operations[messageId] = [
				...(agent.operations[messageId] ?? []),
				...normalized,
			]
		}
	}

	async appendUserMessage(
		agent: ChatAgentState,
		text: string,
		session?: ChatSession,
		userContext?: UserContextItem[],
		isCurrent?: () => boolean,
	) {
		await this.skillRepository?.refresh()
		if (isCurrent && !isCurrent()) return undefined
		const now = Date.now()
		if (session) session.updatedAt = now
		const current = captureWorkspaceContexts(this.app, this.skillRepository)
		const changed = computeChangedContexts(agent.timeline, current)
		const message: AppUIMessage = {
			id: createId('message'),
			role: 'user',
			metadata: {
				createdAt: now,
			},
			parts: [],
		}
		if (changed.length) {
			message.parts.push({
				type: 'data-workspace-context',
				data: { deltas: changed },
			})
		}
		if (userContext?.length) {
			message.parts.push({
				type: 'data-user-context',
				data: { items: copyUserContextItems(userContext) },
			})
		}
		if (text) message.parts.push({ type: 'text', text })
		agent.timeline.push(message)
		return message
	}

	appendAgentInput(
		agent: ChatAgentState,
		input: AppUIMessage,
		session?: ChatSession,
		isCurrent?: () => boolean,
	) {
		if (isCurrent && !isCurrent()) return false
		if (session) session.updatedAt = Date.now()
		agent.timeline.push(input)
		return true
	}

	removeIncompleteToolCalls(agent: ChatAgentState) {
		return removeIncompleteToolCalls(agent)
	}

	reportFatalError(
		session: ChatSession,
		message: string,
		meta?: ChatMessageMeta,
		agent: ChatAgentState = this.getActiveAgent(session),
	) {
		logger.error(message)
		agent.timeline.push(
			this.createMessage(
				{ role: 'assistant', content: [{ type: 'text', text: message }] },
				{ meta, isError: true },
			),
		)
		this.notify()
	}

	findToolPart(agent: ChatAgentState, toolCallId: string) {
		for (let index = agent.timeline.length - 1; index >= 0; index -= 1) {
			const message = agent.timeline[index]
			const part = message.parts.find(
				(candidate): candidate is DynamicToolUIPart =>
					candidate.type === 'dynamic-tool' &&
					candidate.toolCallId === toolCallId,
			)
			if (part) return { message, part }
		}
		return undefined
	}
}
