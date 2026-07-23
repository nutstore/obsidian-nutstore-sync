import {
	isLoopFinished,
	ToolLoopAgent,
	type AssistantModelMessage,
	type ContentPart,
	type ModelMessage,
	type StopCondition,
	type ToolCallPart,
	type ToolSet,
} from 'ai'
import type {
	AIModelConfig,
	AIProviderConfig,
	AppToolMetadata,
} from '~/ai/core/types'
import type { RecordMetadataFn } from '~/ai/tools/tool-context'
import { createSystemPromptForAgent } from '~/ai/chat/prompts'
import type { ChatSession } from '~/ai/chat/domain'
import { AgentEventProjector } from '~/ai/chat/runtime/agent-event-projector'
import type { SessionRuntimeState } from '~/ai/chat/runtime/chat-state'
import type { MessageFactory } from '~/ai/chat/messages/message-factory'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { ToolExecutor } from '~/ai/chat/runtime/tool-executor'
import type { ChatAgentState, ChatMessageMeta } from '~/ai/chat/types'
import { messageToText } from '~/ai/chat/messages/message-utils'
import {
	REPEATED_TOOL_CALL_THRESHOLD,
	type ToolCallRepeatState,
	updateToolCallRepeatState,
} from '~/ai/core/tool-call-repeat'
import {
	prepareMessagesForModel,
	resolveLanguageModel,
} from '~/ai/core/runtime'
import {
	selectContextTimeline,
	uiMessagesToModelMessages,
} from '~/ai/chat/messages/ui-message'
import i18n from '~/i18n'

export type AgentRunResult =
	| { status: 'completed'; text: string }
	| { status: 'failed'; error: string }
	| { status: 'cancelled' }
	| { status: 'suspended'; continuation: ToolCallRepeatState }

interface RunAgentTurnOptions {
	session: ChatSession
	agent: ChatAgentState
	provider: AIProviderConfig
	model: AIModelConfig
	depth: number
	assistantMeta: ChatMessageMeta
	runtime?: SessionRuntimeState
	isCancelled: () => boolean
	isDeleted: () => boolean
	continuation?: ToolCallRepeatState
	abortSignal?: AbortSignal
	shouldSuspendAfterToolStep?: () => boolean | Promise<boolean>
	buildMessages?: (
		agent: ChatAgentState,
		tools: ToolSet,
	) => Promise<ModelMessage[]>
}

export class AgentRunner {
	constructor(
		private toolExecutor: ToolExecutor,
		private store: SessionStore,
		private messageFactory: MessageFactory,
		private notify: () => void,
	) {}

	async runTurn(options: RunAgentTurnOptions): Promise<AgentRunResult> {
		const { session, agent } = options
		const definition = this.toolExecutor.getAgentDefinition(agent.type)
		const tools = this.toolExecutor.createTools(options.depth, definition)
		const stableContext = this.toolExecutor.createStableToolsContext(
			session,
			definition,
		)
		const systemPrompt = createSystemPromptForAgent(
			definition,
			session.systemPrompt,
		)
		const messages = options.buildMessages
			? await options.buildMessages(agent, tools)
			: await uiMessagesToModelMessages(
					selectContextTimeline(agent.timeline),
					tools,
				)

		const projector = new AgentEventProjector({
			session,
			agent,
			runtime: options.runtime,
			store: this.store,
			messageFactory: this.messageFactory,
			notify: this.notify,
			assistantMeta: options.assistantMeta,
			isDeleted: options.isDeleted,
			isCancelled: options.isCancelled,
		})

		const { model } = resolveLanguageModel(options.provider, options.model.id)
		const metadata = new Map<string, AppToolMetadata>()
		const recordMetadata: RecordMetadataFn = (toolCallId, value) =>
			metadata.set(toolCallId, value)

		const readTracker = this.toolExecutor.prepareReadTracker(session, agent.id)
		const fileToolsContext = {
			app: stableContext.app,
			permissionGuard: stableContext.permissionGuard,
			readTracker,
			recordMetadata,
		}
		const toolsContext = {
			bash: {
				...fileToolsContext,
				scratch: stableContext.scratch,
			},
			apply_patch: fileToolsContext,
			note_neighborhood: {
				app: stableContext.app,
				session,
				agentId: agent.id,
			},
			update_session_title: { recordMetadata },
			...(tools.todowrite ? { todowrite: { session, recordMetadata } } : {}),
			...(tools.task
				? {
						task: {
							session,
							agentId: agent.id,
							dispatchTask: stableContext.dispatchTask,
							dispatchableDefinitions: stableContext.dispatchableDefinitions,
						},
					}
				: {}),
		}

		let repeatState: ToolCallRepeatState = options.continuation ?? {
			consecutiveCount: 0,
			isRepeatedTooManyTimes: false,
		}
		let shouldSuspend = false
		let finalMessage: AssistantModelMessage | undefined
		const repeatedToolCalls: StopCondition<typeof tools> = ({ steps }) => {
			const calls = steps.at(-1)?.toolCalls ?? []
			if (!calls.length) return false
			repeatState = updateToolCallRepeatState(
				repeatState,
				calls as ToolCallPart[],
			)
			return repeatState.isRepeatedTooManyTimes
		}
		const suspendAtStepBoundary: StopCondition<typeof tools> = async ({
			steps,
		}) => {
			if (!steps.at(-1)?.toolCalls.length) return false
			shouldSuspend = (await options.shouldSuspendAfterToolStep?.()) ?? false
			return shouldSuspend
		}
		const toolLoop = new ToolLoopAgent({
			model,
			instructions: systemPrompt,
			tools,
			toolsContext,
			stopWhen: [isLoopFinished(), repeatedToolCalls, suspendAtStepBoundary],
			temperature: session.inferenceParams?.temperature,
			maxOutputTokens: session.inferenceParams?.maxTokens,
			prepareStep: async () => {
				readTracker.resetSnapshot()
				await projector.project({ type: 'step-start' })
				return {}
			},
		})
		const result = await toolLoop.stream({
			messages: prepareMessagesForModel(
				options.provider,
				options.model.id,
				messages,
			),
			abortSignal: options.abortSignal,
			onToolExecutionStart: async (event) => {
				if (!event) return
				await projector.project({
					type: 'tool-execution-start',
					toolCall: event.toolCall as ToolCallPart,
				})
			},
			onToolExecutionEnd: async (event) => {
				if (!event?.toolOutput) return
				await projector.project({
					type: 'tool-execution-end',
					toolCallId: event.toolCall.toolCallId,
					durationMs: event.toolExecutionMs,
					toolOutput: event.toolOutput,
				})
			},
			onStepEnd: async (step) => {
				const message = step.response.messages.find(
					(candidate): candidate is AssistantModelMessage =>
						candidate.role === 'assistant',
				)
				if (!message) return
				finalMessage = message
				await projector.project({
					type: 'assistant-step',
					response: {
						message,
						meta: {
							providerId: options.provider.id,
							providerName: options.provider.name,
							modelId: step.response.modelId,
							modelName: options.model.name,
							usage: step.usage,
							finishReason: step.finishReason,
							responseId: step.response.id,
						},
					},
				})
				const outcomes = step.content.filter(
					(part) => part.type === 'tool-result' || part.type === 'tool-error',
				) as Array<
					Extract<ContentPart<ToolSet>, { type: 'tool-result' | 'tool-error' }>
				>
				if (outcomes.length) {
					await projector.project({
						type: 'tool-results',
						outcomes,
						metadata,
					})
				}
			},
		})
		for await (const chunk of result.stream) {
			if (chunk.type === 'text-delta' && chunk.text) {
				await projector.project({ type: 'text-delta', delta: chunk.text })
			}
			if (chunk.type === 'error') throw chunk.error
			if (chunk.type === 'abort') {
				throw options.abortSignal?.reason ?? new Error('Agent run aborted')
			}
		}

		if (options.isCancelled()) {
			return { status: 'cancelled' }
		}
		if (shouldSuspend) {
			return {
				status: 'suspended',
				continuation: repeatState,
			}
		}
		if (repeatState.isRepeatedTooManyTimes) {
			return {
				status: 'failed',
				error: i18n.t('chatbox.repeatedToolCallsStopped', {
					count: REPEATED_TOOL_CALL_THRESHOLD,
				}),
			}
		}
		if (!finalMessage) {
			throw new Error('Agent completed without an assistant response')
		}
		return {
			status: 'completed',
			text:
				messageToText(finalMessage).trim() ||
				i18n.t('chatbox.task.emptyResult'),
		}
	}
}
