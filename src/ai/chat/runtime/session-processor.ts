import { getModelById, getProviderById } from '~/ai/catalog/config'
import { generateAssistantTurn } from '~/ai/core/runtime'
import {
	REPEATED_TOOL_CALL_THRESHOLD,
	ToolCallRepeatState,
	updateToolCallRepeatState,
} from '~/ai/core/tool-call-repeat'
import type { AIMessage, AIMessageRecord, AISession } from '~/ai/core/types'
import type { AssistantModelMessage, TextPart } from 'ai'
import type { ChatUserMessage } from '~/ai/chat/types'
import type { ChatFragment } from '~/ai/chat/domain'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import { extractErrorMessage } from '~/ai/chat/error-utils'
import {
	deriveTitle,
	getAssistantToolCalls,
	messageToText,
} from '~/ai/chat/messages/message-utils'
import { createMainSystemPrompt, MAX_TASK_DEPTH } from '~/ai/chat/prompts'
import type { MessageFactory } from '~/ai/chat/messages/message-factory'
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import type { Selection } from '~/ai/chat/runtime/selection'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { ToolExecutor } from '~/ai/chat/runtime/tool-executor'
import type { UserContextManager } from '~/ai/chat/context/user-context-manager'
import { formatUserContext } from '~/ai/chat/context/user-context'
import { formatAdditionalContext } from '~/ai/chat/context/workspace-context'
import i18n from '~/i18n'
import type NutstorePlugin from '../../..'

export class SessionProcessor {
	constructor(
		private plugin: NutstorePlugin,
		private state: ChatState,
		private runtimeStates: RuntimeStates,
		private store: SessionStore,
		private notify: () => void,
		private selection: Selection,
		private toolExecutor: ToolExecutor,
		private messageFactory: MessageFactory,
		private userContextManager: UserContextManager,
	) {}

	async start(sessionId: string) {
		const runtime = this.runtimeStates.get(sessionId)
		if (runtime.processing) {
			return runtime.processing
		}

		runtime.processing = this.run(sessionId).finally(() => {
			const latestRuntime = this.runtimeStates.get(sessionId)
			latestRuntime.processing = undefined
			if (
				latestRuntime.runState === 'idle' &&
				(latestRuntime.pendingMessages.length ||
					latestRuntime.pendingUserContext.length)
			) {
				void this.start(sessionId)
				return
			}
			if (latestRuntime.runState === 'idle') {
				this.notify()
			}
		})
		return runtime.processing
	}

	private async run(sessionId: string) {
		const runtime = this.runtimeStates.get(sessionId)
		const session = this.state.loadedSessions.get(sessionId)
		if (!session) {
			runtime.runState = 'idle'
			return
		}

		try {
			const provider = this.selection.getProviderOrThrow(session)
			const model = this.selection.getModelOrThrow(provider, session)
			let repeatState: ToolCallRepeatState = {
				consecutiveCount: 0,
				isRepeatedTooManyTimes: false,
			}

			while (true) {
				const fragment = this.messageFactory.getActiveFragment(session)
				const lastMessage =
					fragment.messages[fragment.messages.length - 1]?.message

				if (
					!lastMessage ||
					(lastMessage.role !== 'user' && lastMessage.role !== 'tool')
				) {
					const flushed = await this.flushPendingMessages(session)
					if (!flushed) {
						runtime.runState = 'idle'
						this.notify()
						return
					}
				}

				runtime.runState = 'thinking'
				this.notify()

				const tools = this.toolExecutor.createToolsForContext(
					session,
					0,
					MAX_TASK_DEPTH,
				)
				await this.plugin.nutstoreLlmGatewayService.ensureProviderReady(
					provider,
				)
				const requestMessages = await this.buildMessagesForFragment(
					fragment,
					session,
				)
				const assistantMeta = {
					providerId: provider.id,
					providerName: provider.name,
					modelId: model.id,
					modelName: model.name,
				}
				let assistantRecord: AIMessageRecord | undefined
				const ensureAssistantRecord = () => {
					if (assistantRecord) {
						return assistantRecord
					}
					assistantRecord = this.messageFactory.createMessageRecord(
						{
							role: 'assistant',
							content: [],
						} as AssistantModelMessage,
						{ meta: assistantMeta },
					)
					fragment.messages.push(assistantRecord)
					fragment.updatedAt = Date.now()
					session.updatedAt = Date.now()
					return assistantRecord
				}
				let lastStreamNotifyAt = 0
				const response = await generateAssistantTurn(
					{
						provider,
						model: model.id,
						messages: requestMessages,
						tools,
						...session.inferenceParams,
					},
					{
						onTextDelta: async (delta) => {
							if (
								!delta ||
								this.state.deletedSessionIds.has(session.id) ||
								runtime.stopRequested
							) {
								return
							}
							const record = ensureAssistantRecord()
							if (record.message.role !== 'assistant') {
								return
							}
							type MutablePart = { type: string; text?: string }
							const rawContent = (record.message as AssistantModelMessage)
								.content
							const content: MutablePart[] = Array.isArray(rawContent)
								? [...(rawContent as MutablePart[])]
								: []
							const textIdx = content.findIndex((p) => p.type === 'text')
							const existing = textIdx >= 0 ? (content[textIdx].text ?? '') : ''
							const textPart: MutablePart = {
								type: 'text',
								text: `${existing}${delta}`,
							}
							if (textIdx >= 0) {
								content[textIdx] = textPart
							} else {
								content.push(textPart)
							}
							record.message = {
								...record.message,
								content,
							} as AssistantModelMessage
							fragment.updatedAt = Date.now()
							session.updatedAt = Date.now()
							if (Date.now() - lastStreamNotifyAt >= 33) {
								lastStreamNotifyAt = Date.now()
								this.notify()
							}
						},
					},
				)

				if (this.state.deletedSessionIds.has(session.id)) {
					runtime.stopRequested = false
					runtime.runState = 'idle'
					return
				}

				if (runtime.stopRequested) {
					const record = ensureAssistantRecord()
					record.message = response.message
					record.meta = { ...response.meta, modelId: model.id }
					this.messageFactory.finishStoppedSessionRun(session, fragment)
					await this.store.persistSession(session)
					return
				}

				const record = ensureAssistantRecord()
				record.message = response.message
				record.meta = { ...response.meta, modelId: model.id }
				fragment.updatedAt = Date.now()
				session.updatedAt = Date.now()
				await this.store.persistSession(session)
				this.notify()

				const assistantToolCalls = getAssistantToolCalls(response.message)
				if (!assistantToolCalls?.length) {
					runtime.runState = 'idle'
					continue
				}

				repeatState = updateToolCallRepeatState(repeatState, assistantToolCalls)
				if (repeatState.isRepeatedTooManyTimes) {
					this.messageFactory.reportFatalError(
						session,
						i18n.t('chatbox.repeatedToolCallsStopped', {
							count: REPEATED_TOOL_CALL_THRESHOLD,
						}),
						{
							providerId: provider.id,
							providerName: provider.name,
							modelId: model.id,
							modelName: model.name,
						},
						fragment,
					)
					runtime.runState = 'idle'
					await this.store.persistSession(session)
					return
				}

				runtime.runState = 'waiting_for_tools'
				this.notify()

				const toolMessages = await this.toolExecutor.resolveToolCalls(
					assistantToolCalls,
					tools,
					{
						session,
						depth: 0,
						maxDepth: MAX_TASK_DEPTH,
					},
				)

				if (runtime.stopRequested) {
					this.messageFactory.finishStoppedSessionRun(session, fragment)
					await this.store.persistSession(session)
					return
				}

				for (const item of toolMessages) {
					fragment.messages.push(
						this.messageFactory.createMessageRecord(item.message, {
							isError: item.isError,
							reversibleOps: item.reversibleOps,
						}),
					)
				}
				await this.store.persistSession(session)
				this.notify()
			}
		} catch (error) {
			if (this.state.deletedSessionIds.has(session.id)) {
				runtime.runState = 'idle'
				return
			}
			const activeFragment = this.messageFactory.getActiveFragment(session)
			const lastRecord =
				activeFragment.messages[activeFragment.messages.length - 1]
			if (
				lastRecord &&
				lastRecord.message.role === 'assistant' &&
				!getAssistantToolCalls(lastRecord.message)?.length &&
				!messageToText(lastRecord.message).trim()
			) {
				activeFragment.messages.pop()
			}
			const activeProvider = getProviderById(
				this.plugin.settings.ai.providers,
				session.model?.providerId,
			)
			const activeModel = getModelById(activeProvider, session.model?.modelId)
			this.messageFactory.reportFatalError(
				session,
				extractErrorMessage(error, i18n.t('chatbox.requestFailed')),
				{
					providerId: activeProvider?.id,
					providerName: activeProvider?.name,
					modelId: activeModel?.id,
					modelName: activeModel?.name,
				},
				activeFragment,
			)
			runtime.runState = 'idle'
			await this.store.persistSession(session)
		}
	}

	private async flushPendingMessages(session: AISession) {
		const runtime = this.runtimeStates.get(session.id)
		if (
			runtime.pendingMessages.length === 0 &&
			runtime.pendingUserContext.length === 0
		) {
			return false
		}

		const mergedText = runtime.pendingMessages
			.map((item) => item.text.trim())
			.filter(Boolean)
			.join('\n\n')
		runtime.pendingMessages = []
		const pendingUserContext = runtime.pendingUserContext.splice(0)
		const preparedContext =
			await this.userContextManager.prepareUserContextForMessage(
				pendingUserContext,
			)
		if (!mergedText && preparedContext.dedupedItems.length === 0) {
			this.notify()
			return false
		}

		const fragment = this.messageFactory.getActiveFragment(session)
		this.messageFactory.appendUserMessage(
			fragment,
			mergedText,
			session,
			preparedContext.dedupedItems.length > 0
				? preparedContext.dedupedItems
				: undefined,
			preparedContext.imageParts.length > 0
				? preparedContext.imageParts
				: undefined,
		)
		this.store.upsertSessionIndexItem(session, deriveTitle(session))
		void this.store.persistSession(session)
		void this.store.persistMetaAndIndex()
		this.notify()
		return true
	}

	private async buildMessagesForFragment(
		fragment: ChatFragment,
		session: AISession,
	): Promise<AIMessage[]> {
		const messages = await Promise.all(
			fragment.messages.map(async (item) => {
				if (item.message.role !== 'user') {
					return item.message
				}
				const prefixParts: TextPart[] = []
				if (item.workspaceContextDelta?.length) {
					prefixParts.push({
						type: 'text',
						text: formatAdditionalContext(item.workspaceContextDelta),
					})
				}
				const dedupedContext = item.userContext?.length
					? this.userContextManager.dedupeUserContextItems(item.userContext)
					: []
				const pathAndSelectionContext = dedupedContext.filter(
					(contextItem) =>
						contextItem.type === 'vault-path' ||
						contextItem.type === 'selection',
				)
				if (pathAndSelectionContext.length) {
					prefixParts.push({
						type: 'text',
						text: formatUserContext(pathAndSelectionContext),
					})
				}
				for (const contextItem of dedupedContext) {
					if (contextItem.type !== 'file') {
						continue
					}
					prefixParts.push(
						await this.userContextManager.createTextFileContextPart(
							contextItem,
						),
					)
				}
				if (!prefixParts.length) return item.message
				const userContent = Array.isArray(item.message.content)
					? (item.message as ChatUserMessage).content
					: []
				return {
					...item.message,
					content: [...prefixParts, ...userContent],
				} as AIMessage
			}),
		)
		return [
			{
				role: 'system',
				content: session.systemPrompt || createMainSystemPrompt(MAX_TASK_DEPTH),
			},
			...messages,
		]
	}
}
