import type {
	AssistantModelMessage,
	ContentPart,
	ToolCallPart,
	ToolSet,
} from 'ai'
import type { ChatSession } from '~/ai/chat/domain'
import { extractErrorMessage } from '~/ai/chat/error-utils'
import type { MessageFactory } from '~/ai/chat/messages/message-factory'
import { normalizeReversibleToolOpRecord } from '~/ai/chat/messages/reversible-op-utils'
import type { SessionRuntimeState } from '~/ai/chat/runtime/chat-state'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type {
	AppUIMessage,
	ChatAgentState,
	ChatMessageMeta,
	ReversibleToolOp,
} from '~/ai/chat/types'
import type { AppToolMetadata } from '~/ai/core/types'

export type AgentProjectionEvent =
	| { type: 'step-start' }
	| { type: 'text-delta'; delta: string }
	| { type: 'tool-execution-start'; toolCall: ToolCallPart }
	| {
			type: 'tool-execution-end'
			toolCallId: string
			durationMs: number
			toolOutput:
				| { type: 'tool-result'; output: unknown }
				| { type: 'tool-error'; error: unknown }
	  }
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
	isTurnAlive: () => boolean
}

export class AgentEventProjector {
	private assistantMessage?: AppUIMessage
	private lastStreamNotifyAt = 0

	constructor(private options: AgentEventProjectorOptions) {}

	async project(event: AgentProjectionEvent) {
		if (!this.options.isTurnAlive()) return

		switch (event.type) {
			case 'step-start':
				if (this.options.runtime) this.options.runtime.runState = 'thinking'
				this.options.notify()
				return
			case 'text-delta':
				this.projectTextDelta(event.delta)
				return
			case 'tool-execution-start': {
				const message = this.ensureAssistantMessage()
				const existing = message.parts.find(
					(part) =>
						part.type === 'dynamic-tool' &&
						part.toolCallId === event.toolCall.toolCallId,
				)
				if (!existing) {
					message.parts.push({
						type: 'dynamic-tool',
						toolName: event.toolCall.toolName,
						toolCallId: event.toolCall.toolCallId,
						state: 'input-available',
						input: event.toolCall.input,
						...(event.toolCall.providerExecuted === true
							? { providerExecuted: true }
							: {}),
					})
				}
				this.options.agent.toolTimings[event.toolCall.toolCallId] ??= {
					startedAt: Date.now(),
				}
				if (this.options.runtime)
					this.options.runtime.runState = 'waiting_for_tools'
				this.touch()
				this.options.notify()
				return
			}
			case 'tool-execution-end': {
				const existing = this.options.agent.toolTimings[event.toolCallId]
				const finishedAt = Date.now()
				const startedAt = existing?.startedAt ?? finishedAt - event.durationMs
				this.options.agent.toolTimings[event.toolCallId] = {
					startedAt,
					finishedAt: startedAt + event.durationMs,
				}
				const message = this.assistantMessage
				const partIndex =
					message?.parts.findIndex(
						(part) =>
							part.type === 'dynamic-tool' &&
							part.toolCallId === event.toolCallId,
					) ?? -1
				const part = message?.parts[partIndex]
				if (message && part?.type === 'dynamic-tool') {
					const common = {
						type: 'dynamic-tool' as const,
						toolName: part.toolName,
						toolCallId: part.toolCallId,
						input: part.input,
						...(part.providerExecuted === true
							? { providerExecuted: true }
							: {}),
						...('callProviderMetadata' in part && part.callProviderMetadata
							? { callProviderMetadata: part.callProviderMetadata }
							: {}),
					}
					message.parts[partIndex] =
						event.toolOutput.type === 'tool-error'
							? {
									...common,
									state: 'output-error',
									errorText: extractErrorMessage(
										event.toolOutput.error,
										String(event.toolOutput.error),
									),
								}
							: {
									...common,
									state: 'output-available',
									output: event.toolOutput.output,
								}
				}
				this.touch()
				this.options.notify()
				return
			}
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
					for (let index = 0; index < message.parts.length; index += 1) {
						const part = message.parts[index]
						if (part.type !== 'dynamic-tool') continue
						const existing = this.assistantMessage.parts.find(
							(candidate) =>
								candidate.type === 'dynamic-tool' &&
								candidate.toolCallId === part.toolCallId &&
								(candidate.state === 'output-available' ||
									candidate.state === 'output-error' ||
									candidate.state === 'output-denied'),
						)
						if (existing) message.parts[index] = existing
					}
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
			case 'tool-results': {
				if (!this.options.isTurnAlive()) return
				let titleUpdated = false
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
					if (metadata?.sessionTitle) {
						this.options.store.upsertSessionIndexItem(
							this.options.session,
							metadata.sessionTitle,
						)
						titleUpdated = true
					}
					this.options.messageFactory.setMessageOperations(
						this.options.agent,
						target.message.id,
						metadata?.reversibleOps
							?.map((operation) => ({
								...operation,
								toolCallId: outcome.toolCallId,
							}))
							?.map(normalizeReversibleToolOpRecord)
							.filter(
								(operation): operation is ReversibleToolOp => !!operation,
							),
					)
				}
				this.assistantMessage = undefined
				this.touch()
				await this.options.store.persistSession(this.options.session)
				if (titleUpdated) {
					await this.options.store.persistMetaAndIndex()
				}
				this.options.notify()
			}
		}
	}

	private projectTextDelta(delta: string) {
		if (!delta || !this.options.isTurnAlive()) return
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
			{ role: 'assistant', content: [] },
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
