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
	isImageFilePart,
	messageToText,
} from '~/ai/chat/messages/message-utils'
import { createMainSystemPrompt, MAX_TASK_DEPTH } from '~/ai/chat/prompts'
import type { MessageFactory } from '~/ai/chat/messages/message-factory'
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import type { Selection } from '~/ai/chat/runtime/selection'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { ToolExecutor } from '~/ai/chat/runtime/tool-executor'
import type { UserContextManager } from '~/ai/chat/context/user-context-manager'
import { formatAdditionalContext } from '~/ai/chat/context/workspace-context'
import {
	runContextCompression,
	shouldAutoCompressFragment,
} from '~/ai/chat/runtime/context-compression'
import { hasQueuedSubmission } from '~/ai/chat/runtime/pending-submission'
import { isAbortError } from '~/ai/transport/abort'
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
				hasQueuedSubmission(latestRuntime)
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

				if (shouldAutoCompressFragment(fragment, model)) {
					runtime.runState = 'compressing'
					this.notify()
					await this.plugin.nutstoreLlmGatewayService.ensureProviderReady(
						provider,
					)
					if (runtime.stopRequested) {
						runtime.runState = 'idle'
						await this.store.persistSession(session)
						this.notify()
						return
					}
					const abortController = this.runtimeStates.createAbortController(
						session.id,
					)
					try {
						await runContextCompression({
							provider,
							model,
							session,
							sourceFragment: fragment,
							runtimeStates: this.runtimeStates,
							store: this.store,
							messageFactory: this.messageFactory,
							isSessionDeleted: () =>
								this.state.deletedSessionIds.has(session.id),
							abortSignal: abortController.signal,
						})
					} finally {
						this.runtimeStates.clearAbortController(session.id, abortController)
					}
					if (this.state.deletedSessionIds.has(session.id)) {
						runtime.stopRequested = false
						runtime.runState = 'idle'
						return
					}
					if (runtime.stopRequested) {
						runtime.runState = 'idle'
						await this.store.persistSession(session)
						this.notify()
						return
					}
					this.notify()
					continue
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
				if (runtime.stopRequested) {
					this.messageFactory.finishStoppedSessionRun(session, fragment)
					await this.store.persistSession(session)
					return
				}
				const requestMessages = await this.buildMessagesForFragment(fragment)
				const systemPrompt =
					session.systemPrompt || createMainSystemPrompt(MAX_TASK_DEPTH)
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
				const abortController = this.runtimeStates.createAbortController(
					session.id,
				)
				const response = await (async () => {
					try {
						return await generateAssistantTurn(
							{
								provider,
								model: model.id,
								messages: requestMessages,
								systemPrompt,
								tools,
								abortSignal: abortController.signal,
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
									const existing =
										textIdx >= 0 ? (content[textIdx].text ?? '') : ''
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
					} finally {
						this.runtimeStates.clearAbortController(session.id, abortController)
					}
				})()

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
							todos: item.todos,
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
			if (isAbortError(error) && runtime.stopRequested) {
				this.messageFactory.finishStoppedSessionRun(
					session,
					this.messageFactory.getActiveFragment(session),
				)
				await this.store.persistSession(session)
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
		if (!hasQueuedSubmission(runtime)) {
			return false
		}

		const fragment = this.messageFactory.getActiveFragment(session)
		const pendingSubmissions = runtime.pending.splice(0)
		let appended = false
		for (const submission of pendingSubmissions) {
			const preparedContext =
				await this.userContextManager.prepareUserContextForMessage(
					submission.userContext,
				)
			const normalizedText = submission.text.trim()
			if (!normalizedText && preparedContext.dedupedItems.length === 0) {
				continue
			}
			this.messageFactory.appendUserMessage(
				fragment,
				normalizedText,
				session,
				preparedContext.dedupedItems.length > 0
					? preparedContext.dedupedItems
					: undefined,
			)
			appended = true
		}
		if (!appended) {
			this.notify()
			return false
		}
		this.store.upsertSessionIndexItem(session, deriveTitle(session))
		void this.store.persistSession(session)
		void this.store.persistMetaAndIndex()
		this.notify()
		return true
	}

	private async buildMessagesForFragment(
		fragment: ChatFragment,
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
				const contextParts =
					await this.userContextManager.buildMessagePartsFromUserContext(
						dedupedContext,
					)
				const userContent = Array.isArray(item.message.content)
					? (
							(item.message as ChatUserMessage).content as Array<{
								type: string
							}>
						).filter((part) => {
							if (part.type === 'text' || part.type === 'reasoning') {
								return true
							}
							if (part.type !== 'file') {
								return false
							}
							return (
								!dedupedContext.some(
									(contextItem) => contextItem.type === 'image',
								) && isImageFilePart(part)
							)
						})
					: []
				if (!prefixParts.length && !contextParts.length) {
					return item.message
				}
				return {
					...item.message,
					content: [...prefixParts, ...contextParts, ...userContent],
				} as AIMessage
			}),
		)
		return messages
	}
}
