import type { ModelMessage, ToolSet, UserModelMessage } from 'ai'
import type { ChatSession } from '~/ai/chat/domain'

import { getModelById, getProviderById } from '~/ai/catalog/config'
import type { ChatAgentState } from '~/ai/chat/types'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import { extractErrorMessage } from '~/ai/chat/error-utils'
import { deriveTitle } from '~/ai/chat/messages/message-utils'
import type { MessageFactory } from '~/ai/chat/messages/message-factory'
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import type { Selection } from '~/ai/chat/runtime/selection'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { ToolExecutor } from '~/ai/chat/runtime/tool-executor'
import type { UserContextManager } from '~/ai/chat/context/user-context-manager'
import {
	runContextCompression,
	shouldAutoCompressAgent,
} from '~/ai/chat/runtime/context-compression'
import { hasQueuedSubmission } from '~/ai/chat/runtime/pending-submission'
import { isAbortError } from '~/ai/transport/abort'
import i18n from '~/i18n'
import type NutstorePlugin from '../../..'
import type { ToolCallRepeatState } from '~/ai/core/tool-call-repeat'
import { AgentRunner } from '~/ai/chat/runtime/agent-runner'
import {
	consumePendingInputs,
	getUserContextItems,
	selectContextTimeline,
	uiMessagesToModelMessages,
} from '~/ai/chat/messages/ui-message'

export class SessionProcessor {
	private agentRunner: AgentRunner

	constructor(
		private plugin: NutstorePlugin,
		private state: ChatState,
		private runtimeStates: RuntimeStates,
		private store: SessionStore,
		private notify: () => void,
		private selection: Selection,
		toolExecutor: ToolExecutor,
		private messageFactory: MessageFactory,
		private userContextManager: UserContextManager,
	) {
		this.agentRunner = new AgentRunner(
			toolExecutor,
			store,
			messageFactory,
			notify,
		)
	}

	async start(sessionId: string) {
		const runtime = this.runtimeStates.get(sessionId)
		if (runtime.processing) {
			return runtime.processing
		}

		runtime.processing = this.run(sessionId).finally(() => {
			const latestRuntime = this.runtimeStates.get(sessionId)
			latestRuntime.processing = undefined
			const latestSession = this.state.loadedSessions.get(sessionId)
			const hasAgentInput = Boolean(
				latestSession &&
				this.messageFactory.getActiveAgent(latestSession).pendingInputs.length,
			)
			if (
				latestRuntime.runState === 'idle' &&
				(hasQueuedSubmission(latestRuntime) || hasAgentInput)
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
			const initialAgent = this.messageFactory.getActiveAgent(session)
			if (this.messageFactory.removeIncompleteToolCalls(initialAgent)) {
				const now = Date.now()
				session.updatedAt = now
				await this.store.persistSession(session)
			}
			const provider = this.selection.getProviderOrThrow(session)
			const model = this.selection.getModelOrThrow(provider, session)
			let agentContinuation: ToolCallRepeatState | undefined
			while (true) {
				const agent = this.messageFactory.getActiveAgent(session)
				if (consumePendingInputs(agent)) {
					session.updatedAt = Date.now()
					await this.store.persistSession(session)
				}
				const lastMessage = agent.timeline[agent.timeline.length - 1]

				if (
					!agentContinuation &&
					(!lastMessage || lastMessage.role !== 'user')
				) {
					const flushed = await this.flushPendingMessages(session)
					if (!flushed) {
						runtime.runState = 'idle'
						this.notify()
						return
					}
				}

				if (shouldAutoCompressAgent(agent, model)) {
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
							agent,
							store: this.store,
							messageFactory: this.messageFactory,
							isCancelled: () =>
								this.runtimeStates.get(session.id).stopRequested ||
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

				await this.plugin.nutstoreLlmGatewayService.ensureProviderReady(
					provider,
				)
				if (runtime.stopRequested) {
					this.messageFactory.finishStoppedSessionRun(session, agent)
					await this.store.persistSession(session)
					return
				}
				const assistantMeta = {
					providerId: provider.id,
					providerName: provider.name,
					modelId: model.id,
					modelName: model.name,
				}
				const abortController = this.runtimeStates.createAbortController(
					session.id,
				)
				const turnResult = await (async () => {
					try {
						return await this.agentRunner.runTurn({
							session,
							agent,
							provider,
							model,
							depth: 0,
							assistantMeta,
							runtime,
							isCancelled: () =>
								runtime.stopRequested ||
								this.state.deletedSessionIds.has(session.id),
							isDeleted: () => this.state.deletedSessionIds.has(session.id),
							continuation: agentContinuation,
							abortSignal: abortController.signal,
							buildMessages: (a, tools) => this.buildMessagesForAgent(a, tools),
							shouldSuspendAfterToolStep: () =>
								runtime.stopRequested ||
								this.state.deletedSessionIds.has(session.id) ||
								shouldAutoCompressAgent(agent, model),
						})
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
					this.messageFactory.finishStoppedSessionRun(session, agent)
					await this.store.persistSession(session)
					return
				}

				if (turnResult.status === 'failed') {
					this.messageFactory.reportFatalError(
						session,
						turnResult.error,
						assistantMeta,
						agent,
					)
					runtime.runState = 'idle'
					await this.store.persistSession(session)
					return
				}
				agentContinuation =
					turnResult.status === 'suspended'
						? turnResult.continuation
						: undefined
				if (turnResult.status === 'completed') runtime.runState = 'idle'
				continue
			}
		} catch (error) {
			if (this.state.deletedSessionIds.has(session.id)) {
				runtime.runState = 'idle'
				return
			}
			if (isAbortError(error) && runtime.stopRequested) {
				this.messageFactory.finishStoppedSessionRun(
					session,
					this.messageFactory.getActiveAgent(session),
				)
				await this.store.persistSession(session)
				return
			}
			const activeAgent = this.messageFactory.getActiveAgent(session)
			this.messageFactory.removeIncompleteToolCalls(activeAgent)
			const lastMessage = activeAgent.timeline[activeAgent.timeline.length - 1]
			if (
				lastMessage?.role === 'assistant' &&
				lastMessage.parts.every((part) => part.type === 'step-start')
			) {
				activeAgent.timeline.pop()
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
				activeAgent,
			)
			runtime.runState = 'idle'
			await this.store.persistSession(session)
		}
	}

	private async flushPendingMessages(session: ChatSession) {
		const runtime = this.runtimeStates.get(session.id)
		if (!hasQueuedSubmission(runtime)) {
			return false
		}

		const agent = this.messageFactory.getActiveAgent(session)
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
			await this.messageFactory.appendUserMessage(
				agent,
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

	private async buildMessagesForAgent(
		agent: ChatAgentState,
		tools: ToolSet,
	): Promise<ModelMessage[]> {
		const timeline = selectContextTimeline(agent.timeline)
		const messages = await Promise.all(
			timeline.map(async (item) => {
				const converted = await uiMessagesToModelMessages([item], tools)
				if (item.role !== 'user' || converted.length === 0) return converted
				const modelMessage = converted[0]
				const userContext = getUserContextItems(item)
				const dedupedContext = userContext.length
					? this.userContextManager.dedupeUserContextItems(userContext)
					: []
				const contextParts =
					await this.userContextManager.buildMessagePartsFromUserContext(
						dedupedContext,
					)
				if (!contextParts.length) return converted
				const userContent = Array.isArray(modelMessage.content)
					? (modelMessage as UserModelMessage).content
					: []
				return [
					{
						...modelMessage,
						content: [...contextParts, ...userContent],
					} as ModelMessage,
				]
			}),
		)
		return messages.flat()
	}
}
