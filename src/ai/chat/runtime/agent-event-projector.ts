import type { AssistantModelMessage, ContentPart, ToolSet } from 'ai'
import type { ChatSession } from '~/ai/chat/domain'
import type { MessageFactory } from '~/ai/chat/messages/message-factory'
import type { SessionRuntimeState } from '~/ai/chat/runtime/chat-state'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type {
	AppUIMessage,
	ChatAgentState,
	ChatMessageMeta,
	ReversibleToolOp,
} from '~/ai/chat/types'
import { extractErrorMessage } from '~/ai/chat/error-utils'
import { normalizeReversibleToolOpRecord } from '~/ai/chat/messages/reversible-op-utils'
import type { AppToolMetadata } from '~/ai/core/types'

export type AgentProjectionEvent =
	| { type: 'step-start' }
	| { type: 'text-delta'; delta: string }
	| {
			type: 'assistant-step'
			response: {
				message: AssistantModelMessage
				meta: ChatMessageMeta
			}
	  }
	| {
			type: 'tool-results'
			outcomes: Array<
				Extract<ContentPart<ToolSet>, { type: 'tool-result' | 'tool-error' }>
			>
			metadata: ReadonlyMap<string, AppToolMetadata>
	  }

interface AgentEventProjectorOptions {
	session: ChatSession
	agent: ChatAgentState
	runtime?: SessionRuntimeState
	store: SessionStore
	messageFactory: MessageFactory
	notify: () => void
	assistantMeta: ChatMessageMeta
	isDeleted: () => boolean
	isCancelled: () => boolean
}

export class AgentEventProjector {
	private assistantMessage?: AppUIMessage
	private lastStreamNotifyAt = 0

	constructor(private options: AgentEventProjectorOptions) {}

	async project(event: AgentProjectionEvent) {
		if (this.options.isDeleted()) return

		switch (event.type) {
			case 'step-start':
				if (this.options.runtime) this.options.runtime.runState = 'thinking'
				this.options.notify()
				return
			case 'text-delta':
				this.projectTextDelta(event.delta)
				return
			case 'assistant-step': {
				const message = this.options.messageFactory.createMessage(
					event.response.message,
					{
						meta: {
							...event.response.meta,
							modelId: this.options.assistantMeta.modelId,
						},
					},
				)
				if (this.assistantMessage) {
					message.id = this.assistantMessage.id
					const index = this.options.agent.timeline.findIndex(
						(item) => item.id === this.assistantMessage?.id,
					)
					if (index >= 0) this.options.agent.timeline[index] = message
				} else {
					this.options.agent.timeline.push(message)
				}
				this.assistantMessage = message
				if (message.parts.some((part) => part.type === 'dynamic-tool')) {
					if (this.options.runtime)
						this.options.runtime.runState = 'waiting_for_tools'
				}
				this.touch()
				await this.options.store.persistSession(this.options.session)
				this.options.notify()
				return
			}
			case 'tool-results':
				if (this.options.isCancelled()) return
				for (const outcome of event.outcomes) {
					const target = this.options.messageFactory.findToolPart(
						this.options.agent,
						outcome.toolCallId,
					)
					if (!target) continue
					const common = {
						type: 'dynamic-tool' as const,
						toolName: outcome.toolName,
						toolCallId: outcome.toolCallId,
						input: outcome.input,
						...(outcome.providerExecuted === true
							? { providerExecuted: true }
							: {}),
						...('callProviderMetadata' in target.part &&
						target.part.callProviderMetadata
							? { callProviderMetadata: target.part.callProviderMetadata }
							: {}),
					}
					const partIndex = target.message.parts.indexOf(target.part)
					target.message.parts[partIndex] =
						outcome.type === 'tool-error'
							? {
									...common,
									state: 'output-error',
									errorText: extractErrorMessage(
										outcome.error,
										String(outcome.error),
									),
								}
							: {
									...common,
									state: 'output-available',
									output: outcome.output,
								}
					if (outcome.type === 'tool-error') continue
					const metadata = event.metadata.get(outcome.toolCallId)
					if (metadata?.todos?.length) {
						target.message.parts.push({
							type: 'data-todos',
							data: { items: metadata.todos },
						})
					}
					this.options.messageFactory.setMessageOperations(
						this.options.agent,
						target.message.id,
						metadata?.reversibleOps
							?.map(normalizeReversibleToolOpRecord)
							.filter(
								(operation): operation is ReversibleToolOp => !!operation,
							),
					)
				}
				this.assistantMessage = undefined
				this.touch()
				await this.options.store.persistSession(this.options.session)
				this.options.notify()
		}
	}

	private projectTextDelta(delta: string) {
		if (!delta || this.options.isCancelled()) return
		const message = this.ensureAssistantMessage()
		const part = message.parts.find((item) => item.type === 'text')
		if (part?.type === 'text') part.text += delta
		else message.parts.push({ type: 'text', text: delta })
		this.touch()
		if (Date.now() - this.lastStreamNotifyAt >= 33) {
			this.lastStreamNotifyAt = Date.now()
			this.options.notify()
		}
	}

	private ensureAssistantMessage() {
		if (this.assistantMessage) return this.assistantMessage
		this.assistantMessage = this.options.messageFactory.createMessage(
			{ role: 'assistant', content: [] } as AssistantModelMessage,
			{ meta: this.options.assistantMeta },
		)
		this.options.agent.timeline.push(this.assistantMessage)
		this.touch()
		return this.assistantMessage
	}

	private touch() {
		this.options.session.updatedAt = Date.now()
	}
}
