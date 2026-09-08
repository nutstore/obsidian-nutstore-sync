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
import type { App } from 'obsidian'
import type { ChatSession } from '~/ai/chat/domain'
import type { MessageFactory } from '~/ai/chat/messages/message-factory'
import { messageToText } from '~/ai/chat/messages/message-utils'
import {
	selectContextTimeline,
	uiMessagesToModelMessages,
} from '~/ai/chat/messages/ui-message'
import { buildAgentSystemPrompt } from '~/ai/chat/prompts'
import { AgentEventProjector } from '~/ai/chat/runtime/agent-event-projector'
import type { SessionRuntimeState } from '~/ai/chat/runtime/chat-state'
import { resolveSummaryContext } from '~/ai/chat/runtime/context-compression'
import type { ToolExecutor } from '~/ai/chat/runtime/tool-executor'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { ChatAgentState, ChatMessageMeta } from '~/ai/chat/types'
import {
	prepareMessagesForModel,
	resolveLanguageModel,
} from '~/ai/core/runtime'
import { resolveModelOutputLimit } from '~/ai/core/inference'
import {
	REPEATED_TOOL_CALL_THRESHOLD,
	updateToolCallRepeatState,
	type ToolCallRepeatState,
} from '~/ai/core/tool-call-repeat'
import type { TaskOrigin } from '~/ai/chat/runtime/master-turn-scheduler'
import type {
	AIModelConfig,
	AIProviderConfig,
	AppToolMetadata,
} from '~/ai/core/types'
import type { RecordMetadataFn } from '~/ai/tools/tool-context'
import {
	createViewImageAttachmentMessage,
	InMemoryViewImageAttachmentRegistry,
} from '~/ai/tools/view-image-attachments'
import { createAbortError } from '~/ai/transport/abort'
import i18n from '~/i18n'

export type AgentTurnResult =
	| { status: 'completed'; text: string }
	| { status: 'needs-compaction'; continuation: ToolCallRepeatState }

interface RunAgentTurnOptions {
	session: ChatSession
	agent: ChatAgentState
	provider: AIProviderConfig
	model: AIModelConfig
	depth: number
	assistantMeta: ChatMessageMeta
	runtime?: SessionRuntimeState
	isTurnAlive: () => boolean
	taskOrigin: TaskOrigin
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
		private app: App,
	) {}

	async runTurn(options: RunAgentTurnOptions): Promise<AgentTurnResult> {
		const { session, agent } = options
		const definition = this.toolExecutor.getAgentDefinition(agent.type)
		const tools = await this.toolExecutor.createTools(
			options.depth,
			definition,
			session,
			options.model,
		)
		const stableContext = this.toolExecutor.createStableToolsContext(
			session,
			definition,
		)
		const systemPrompt = await buildAgentSystemPrompt(
			this.app,
			agent.type,
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
			isTurnAlive: options.isTurnAlive,
		})

		const { model } = resolveLanguageModel(options.provider, options.model.id)
		const metadata = new Map<string, AppToolMetadata>()
		const recordMetadata: RecordMetadataFn = (toolCallId, value) =>
			metadata.set(toolCallId, value)

		const readTracker = this.toolExecutor.prepareReadTracker(session, agent.id)
		const viewImageAttachments =
			options.runtime?.viewImageAttachments ??
			new InMemoryViewImageAttachmentRegistry()
		if (options.runtime) {
			options.runtime.viewImageAttachments = viewImageAttachments
		}
		const fileToolsContext = {
			app: stableContext.app,
			fileSystemManager: stableContext.fileSystemManager,
			permissionGuard: stableContext.permissionGuard,
			readTracker,
			recordMetadata,
		}
		const toolsContext = {
			bash: {
				...fileToolsContext,
				getSettingsSnapshot: stableContext.getSettingsSnapshot,
				updateSettings: stableContext.updateSettings,
			},
			apply_patch: {
				...fileToolsContext,
				getSettingsSnapshot: stableContext.getSettingsSnapshot,
				updateSettings: stableContext.updateSettings,
			},
			view_image: {
				app: stableContext.app,
				fileSystemManager: stableContext.fileSystemManager,
				readTracker,
				viewImageAttachments,
			},
			update_session_title: { recordMetadata },
			...(tools.todowrite ? { todowrite: { session, recordMetadata } } : {}),
			...(tools.task
				? {
						task: {
							session,
							agentId: agent.id,
							origin: options.taskOrigin,
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
			maxOutputTokens: resolveModelOutputLimit(options.model),
			prepareStep: async ({ messages, steps }) => {
				readTracker.resetSnapshot()
				await projector.project({ type: 'step-start' })
				const attachments = viewImageAttachments.takeUninjected(
					(steps.at(-1)?.toolCalls ?? []) as ToolCallPart[],
				)
				const attachmentMessage = createViewImageAttachmentMessage(attachments)
				if (!attachmentMessage) return {}
				return {
					messages: [...messages, attachmentMessage],
				}
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
					toolCall: event.toolCall,
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

		if (!options.isTurnAlive()) {
			throw createAbortError('Agent turn cancelled')
		}
		if (shouldSuspend) {
			return {
				status: 'needs-compaction',
				continuation: repeatState,
			}
		}
		if (repeatState.isRepeatedTooManyTimes) {
			throw new Error(
				i18n.t('chatbox.repeatedToolCallsStopped', {
					count: REPEATED_TOOL_CALL_THRESHOLD,
				}),
			)
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

	/**
	 * Resolve the system prompt + per-agent tools used by the summarizer so the
	 * compression call replays a genuine prefix of the last routed request.
	 * Delegates to {@link resolveSummaryContext} with this runner's own
	 * tool executor and Obsidian app. Compression receives schemas only: its
	 * model call cannot execute tools or dispatch subagents.
	 */
	async resolveSummaryContext(
		agent: ChatAgentState,
		session: ChatSession,
		model: AIModelConfig,
	): Promise<{
		system?: string
		tools?: ToolSet
	}> {
		return resolveSummaryContext(
			agent,
			session,
			model,
			this.toolExecutor,
			this.app,
		)
	}
}
