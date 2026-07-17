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
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import createId from '~/utils/create-id'
import logger from '~/utils/logger'
import type { SkillRepository } from '~/ai/skills/repository'
import type NutstorePlugin from '../../..'
import {
	getMessageText,
	modelMessageToUIMessage,
} from '~/ai/chat/messages/ui-message'

export class MessageFactory {
	constructor(
		private plugin: NutstorePlugin,
		private runtimeStates: RuntimeStates,
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
	) {
		await this.skillRepository?.refresh()
		const now = Date.now()
		if (session) session.updatedAt = now
		const current = captureWorkspaceContexts(
			this.plugin.app,
			this.skillRepository,
		)
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
	}

	removeIncompleteToolCalls(agent: ChatAgentState) {
		let changed = false
		agent.timeline = agent.timeline.filter((message) => {
			if (message.role !== 'assistant') return true
			const nextParts = message.parts.filter((part) => {
				if (part.type !== 'dynamic-tool') return true
				const complete =
					part.state === 'output-available' ||
					part.state === 'output-error' ||
					part.state === 'output-denied'
				if (!complete) changed = true
				return complete
			})
			if (nextParts.length !== message.parts.length) message.parts = nextParts
			if (
				!message.parts.length ||
				(!getMessageText(message).trim() &&
					message.parts.every((part) => part.type === 'step-start'))
			) {
				changed = true
				return false
			}
			return true
		})
		return changed
	}

	finishStoppedSessionRun(session: ChatSession, agent: ChatAgentState) {
		const runtime = this.runtimeStates.get(session.id)
		this.removeIncompleteToolCalls(agent)
		runtime.stopRequested = false
		runtime.runState = 'idle'
		this.notify()
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
