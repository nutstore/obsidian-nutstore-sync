import { Notice } from 'obsidian'
import {
	getModelById,
	getProviderById,
	listModels,
	listProviders,
	resolveInitialSelection,
} from '~/ai/catalog/config'
import { generateAssistantTurn } from '~/ai/core/runtime'
import { AISession } from '~/ai/core/types'
import { mutateTaskRecord, toCancelledTask } from '~/ai/chat/domain'
import {
	deriveTitle,
	messageToText,
	toTextParts,
} from '~/ai/chat/messages/message-utils'
import { extractErrorMessage } from '~/ai/chat/error-utils'
import { COMPRESSION_PROMPT } from '~/ai/chat/prompts'
import {
	ChatState,
	type SessionRuntimeState,
} from '~/ai/chat/runtime/chat-state'
import { Notifier } from '~/ai/chat/notifier'
import { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import { Selection } from '~/ai/chat/runtime/selection'
import { SessionStore } from '~/ai/chat/session/session-store'
import { TaskManager } from '~/ai/chat/runtime/task-manager'
import { ToolExecutor } from '~/ai/chat/runtime/tool-executor'
import { UserContextManager } from '~/ai/chat/context/user-context-manager'
import { MessageFactory } from '~/ai/chat/messages/message-factory'
import { MessageOps } from '~/ai/chat/messages/message-ops'
import { SessionProcessor } from '~/ai/chat/runtime/session-processor'
import { exportSessionToMarkdownFile } from '~/ai/chat/messages/export-session'
import {
	buildTimeline,
	collectOtherBusySessionIds,
	collectOtherSessionTasks,
} from '~/ai/chat/ui/view-projection'
import { type UserContextItem } from '~/ai/chat/context/user-context'
import type { ChatFragment } from '~/ai/chat/domain'
import type {
	ChatboxProps,
	ChatProviderOption,
	RecallMessageResult,
} from '~/ai/chat/ui/types'
import SessionExportModal from '~/components/SessionExportModal'
import i18n from '~/i18n'
import { chatSessionKV } from '~/storage'
import createId from '~/utils/create-id'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'

type ChatboxActionHandlers = Pick<
	ChatboxProps,
	| 'onNewSession'
	| 'onNewFragment'
	| 'onCompressContext'
	| 'onSwitchSession'
	| 'onExportSession'
	| 'onDeleteSession'
	| 'onSelectProvider'
	| 'onSelectModel'
	| 'onSendMessage'
	| 'onUpdateInputDraft'
	| 'onAddUserContext'
	| 'onRemoveUserContext'
	| 'onResolvePendingContextItem'
	| 'onDropContextItem'
	| 'onStopActiveRun'
	| 'onCancelTask'
	| 'onDeleteMessage'
	| 'onRegenerateMessage'
	| 'onRecallMessage'
	| 'onRecallHasReversibleOps'
>

type ChatboxViewRuntime = Pick<
	SessionRuntimeState,
	'runState' | 'pendingMessages' | 'pendingUserContext' | 'pendingInputDraft'
>

type ViewSelectionState = {
	selectedProviderId?: string
	selectedModelId?: string
}

export default class ChatService {
	private readonly state = new ChatState()
	private readonly notifier = new Notifier()
	private readonly runtimeStates = new RuntimeStates(this.state)
	private readonly selection: Selection
	private readonly store: SessionStore
	private readonly toolExecutor: ToolExecutor
	private readonly taskManager: TaskManager
	private readonly userContextManager: UserContextManager
	private readonly messageFactory: MessageFactory
	private readonly messageOps: MessageOps
	private readonly sessionProcessor: SessionProcessor

	constructor(private plugin: NutstorePlugin) {
		this.selection = new Selection(
			plugin,
			this.state,
			this.runtimeStates,
			() => this.notify(),
			(session) => this.store.persistSession(session),
		)
		this.store = new SessionStore(
			this.state,
			this.runtimeStates,
			this.selection,
		)
		this.toolExecutor = new ToolExecutor(plugin, this.state, this.runtimeStates)
		this.taskManager = new TaskManager(
			plugin,
			this.state,
			this.selection,
			this.store,
			() => this.notify(),
			this.toolExecutor,
		)
		this.toolExecutor.setSpawnTaskHandler((rawArgs, ctx) =>
			this.taskManager.startSpawnedTask(rawArgs, ctx),
		)
		this.userContextManager = new UserContextManager(
			this.state,
			this.runtimeStates,
			() => this.notify(),
		)
		this.messageFactory = new MessageFactory(plugin, this.runtimeStates, () =>
			this.notify(),
		)
		this.messageOps = new MessageOps(
			plugin,
			this.state,
			this.runtimeStates,
			this.store,
			() => this.notify(),
			this.messageFactory,
			(session) => this.selection.validateSessionSelection(session),
			(sessionId) => this.sessionProcessor.start(sessionId),
		)
		this.sessionProcessor = new SessionProcessor(
			plugin,
			this.state,
			this.runtimeStates,
			this.store,
			() => this.notify(),
			this.selection,
			this.toolExecutor,
			this.messageFactory,
			this.userContextManager,
		)
	}

	private notify() {
		this.notifier.notify()
	}

	async initialize() {
		if (this.state.initialization) {
			return this.state.initialization
		}

		this.state.initialization = this.initializeInternal().catch((error) => {
			this.state.initialization = undefined
			throw error
		})
		return this.state.initialization
	}

	private async initializeInternal() {
		await this.store.loadSessionIndex()

		if (this.state.sessionIndex.length === 0) {
			const session = this.createEmptySession()
			this.state.activeSessionId = session.id
			this.state.loadedSessions.set(session.id, session)
			this.store.upsertSessionIndexItem(session)
			await this.store.persistSession(session)
			await this.store.persistMetaAndIndex()
			return
		}

		const fallbackSessionId =
			this.state.activeSessionId &&
			this.state.sessionIndex.some(
				(item) => item.id === this.state.activeSessionId,
			)
				? this.state.activeSessionId
				: this.state.sessionIndex[0]?.id
		this.state.activeSessionId = fallbackSessionId
		if (fallbackSessionId) {
			await this.store.loadSessionById(fallbackSessionId)
			await this.store.persistMetaAndIndex()
		}
	}

	subscribe(listener: () => void) {
		return this.notifier.subscribe(listener)
	}

	async handleSettingsChanged() {
		await this.initialize()
		const persisted: Promise<unknown>[] = []
		this.selection.syncPendingSelectionWithSettings()
		for (const session of this.state.loadedSessions.values()) {
			if (this.selection.sanitizeSessionSelection(session)) {
				persisted.push(this.store.persistSession(session))
			}
		}

		if (persisted.length > 0) {
			await Promise.all(persisted)
		}
		this.notify()
	}

	getViewProps(): ChatboxProps {
		const activeSession = this.getLoadedActiveSession()
		const activeRuntime = this.getViewRuntime(activeSession)
		const selection = this.resolveViewSelection(activeSession)

		return {
			title: this.getActiveSessionTitle(),
			sessionHistory: this.state.sessionIndex.map((item) => ({ ...item })),
			activeSessionId: this.state.activeSessionId,
			timeline: activeSession ? buildTimeline(activeSession) : [],
			currentSessionTasks: this.getCurrentSessionTasks(activeSession),
			otherSessionTasks: collectOtherSessionTasks(
				this.state.loadedSessions,
				this.state.activeSessionId,
			),
			otherBusySessionIds: collectOtherBusySessionIds(
				this.state.loadedSessions,
				this.state.activeSessionId,
				(id) => this.runtimeStates.get(id),
			),
			providers: this.buildProviderOptions(),
			selectedProviderId: selection.selectedProviderId,
			selectedModelId: selection.selectedModelId,
			runState: activeRuntime.runState,
			pendingMessages: activeRuntime.pendingMessages.map((item) => ({
				...item,
			})),
			pendingUserContext: activeRuntime.pendingUserContext.slice(),
			pendingInputDraft: activeRuntime.pendingInputDraft,
			canSend: !activeRuntime.pendingUserContext.some(
				(item) => item.type === 'pending-context',
			),
			canCreateFragment: !!activeSession && activeRuntime.runState === 'idle',
			canCompress:
				!!activeSession &&
				activeRuntime.runState === 'idle' &&
				this.messageFactory.getActiveFragment(activeSession).messages.length >
					0,
			...this.bindViewActions(),
		}
	}

	private getViewRuntime(activeSession?: AISession): ChatboxViewRuntime {
		if (activeSession) {
			return this.runtimeStates.get(activeSession.id)
		}
		return {
			runState: 'idle',
			pendingMessages: [],
			pendingUserContext: [] as UserContextItem[],
			pendingInputDraft: '',
		}
	}

	private resolveViewSelection(activeSession?: AISession): ViewSelectionState {
		const fallbackSelection = resolveInitialSelection(
			this.plugin.settings.ai.providers,
			this.plugin.settings.ai.defaultModel,
		)
		const emptyStateSelection = this.selection.getEmptyStateSelection()
		const providerId = activeSession
			? activeSession.model?.providerId
			: emptyStateSelection.providerId || fallbackSelection.providerId
		const modelId = activeSession
			? activeSession.model?.modelId
			: emptyStateSelection.modelId || fallbackSelection.modelId
		const selectedProvider = getProviderById(
			this.plugin.settings.ai.providers,
			providerId,
		)
		const selectedModel = getModelById(selectedProvider, modelId)

		return {
			selectedProviderId: selectedProvider?.id,
			selectedModelId: selectedModel?.id,
		}
	}

	private getActiveSessionTitle() {
		return (
			this.state.sessionIndex.find(
				(item) => item.id === this.state.activeSessionId,
			)?.title || i18n.t('chatbox.newChat')
		)
	}

	private getCurrentSessionTasks(activeSession?: AISession) {
		return activeSession
			? activeSession.tasks
					.slice()
					.sort((left, right) => right.createdAt - left.createdAt)
			: []
	}

	private buildProviderOptions(): ChatProviderOption[] {
		return listProviders(this.plugin.settings.ai.providers).map((provider) => ({
			id: provider.id,
			name: provider.name || i18n.t('settings.ai.unnamedProvider'),
			models: listModels(provider).map((model) => ({
				id: model.id,
				name: model.name || i18n.t('settings.ai.unnamedModel'),
			})),
		}))
	}

	private bindViewActions(): ChatboxActionHandlers {
		return {
			onNewSession: () => void this.createSession(),
			onNewFragment: () => this.createFragmentForActiveSession(),
			onCompressContext: () => this.compressContext(),
			onSwitchSession: (sessionId: string) =>
				void this.switchSession(sessionId),
			onExportSession: (sessionId: string) => this.exportSession(sessionId),
			onDeleteSession: (sessionId: string) => this.deleteSession(sessionId),
			onSelectProvider: (providerId: string) => this.selectProvider(providerId),
			onSelectModel: (modelId: string) => this.selectModel(modelId),
			onSendMessage: (text: string) => this.sendMessage(text),
			onUpdateInputDraft: (text: string) => this.updateInputDraft(text),
			onAddUserContext: (item: UserContextItem) => this.addUserContext(item),
			onRemoveUserContext: (index: number) => this.removeUserContext(index),
			onResolvePendingContextItem: (
				id: string,
				replacement: UserContextItem | null,
			) => this.resolvePendingContextItem(id, replacement),
			onDropContextItem: (_path: string) => {
				// overridden by the view layer which has access to app.vault
			},
			onStopActiveRun: () => this.stopActiveSessionRun(),
			onCancelTask: (taskId: string) => this.cancelTask(taskId),
			onDeleteMessage: (messageId: string) => this.deleteMessage(messageId),
			onRegenerateMessage: (messageId: string) =>
				this.regenerateMessage(messageId),
			onRecallMessage: (
				messageId: string,
				options?: { restoreFiles?: boolean },
			) => this.recallMessage(messageId, options),
			onRecallHasReversibleOps: (messageId: string) =>
				this.messageOps.recallMessageHasReversibleOps(messageId),
		}
	}

	async ensureSession() {
		await this.initialize()
	}

	async createSession() {
		await this.initialize()
		const session = this.createEmptySession()
		this.state.loadedSessions.set(session.id, session)
		this.state.activeSessionId = session.id
		this.store.upsertSessionIndexItem(session, i18n.t('chatbox.newChat'), true)
		this.runtimeStates.get(session.id)
		await this.store.persistSession(session)
		await this.store.persistMetaAndIndex()
		this.notify()
		return session
	}

	async switchSession(sessionId: string) {
		await this.initialize()
		if (!this.state.sessionIndex.some((item) => item.id === sessionId)) {
			return
		}

		await this.store.loadSessionById(sessionId)
		this.state.activeSessionId = sessionId
		await this.store.persistMetaAndIndex()
		this.notify()
	}

	async deleteSession(sessionId: string) {
		await this.initialize()
		if (!this.state.sessionIndex.some((item) => item.id === sessionId)) {
			return
		}

		this.state.deletedSessionIds.add(sessionId)
		const session = this.state.loadedSessions.get(sessionId)
		if (session) {
			await this.stopSessionRun(session)
			this.taskManager.cancelAllNonTerminalTasks(session, 'user_cancelled')
			this.taskManager.cleanupSessionTaskTracking(session)
		}

		this.state.sessionIndex = this.state.sessionIndex.filter(
			(item) => item.id !== sessionId,
		)
		if (this.state.activeSessionId === sessionId) {
			this.state.activeSessionId = this.state.sessionIndex[0]?.id
			if (this.state.activeSessionId) {
				await this.store.loadSessionById(this.state.activeSessionId)
			}
		}

		this.state.loadedSessions.delete(sessionId)
		this.state.runtimeBySessionId.delete(sessionId)
		this.state.autoApproveRequestsBySessionId.delete(sessionId)
		await chatSessionKV.unset(sessionId)
		await this.store.persistMetaAndIndex()
		this.notify()
		new Notice(i18n.t('chatbox.sessionDeleted'))
	}

	async exportSession(sessionId: string) {
		await this.initialize()
		if (!this.state.sessionIndex.some((item) => item.id === sessionId)) {
			new Notice(i18n.t('chatbox.errors.sessionNotFound'))
			return
		}

		const options = await SessionExportModal.open(
			this.plugin.app,
			this.toolExecutor.getChatModalMountTarget(),
		)
		if (!options) {
			return
		}

		try {
			const session = await this.store.loadSessionById(sessionId)
			const title =
				this.state.sessionIndex.find((item) => item.id === sessionId)?.title ||
				deriveTitle(session)
			const file = await exportSessionToMarkdownFile({
				vault: this.plugin.app.vault,
				manifestId: this.plugin.manifest.id,
				session,
				title,
				includeToolMessages: options.includeToolMessages,
			})
			const leaf = this.plugin.app.workspace.getLeaf('tab')
			await leaf.openFile(file)
			new Notice(i18n.t('chatbox.exportSaved', { fileName: file.path }))
		} catch (error) {
			new Notice(i18n.t('chatbox.exportFailed'))
			logger.error('Failed to export chat session:', error)
		}
	}

	setChatModalHost(rootEl?: HTMLElement) {
		this.state.chatModalHostEl = rootEl?.isConnected ? rootEl : undefined
	}

	selectProvider(providerId: string) {
		this.selection.selectProvider(providerId)
	}

	selectModel(modelId: string) {
		this.selection.selectModel(modelId)
	}

	addUserContext(item: UserContextItem) {
		this.userContextManager.addUserContext(item)
	}

	removeUserContext(index: number) {
		this.userContextManager.removeUserContext(index)
	}

	resolvePendingContextItem(id: string, replacement: UserContextItem | null) {
		this.userContextManager.resolvePendingContextItem(id, replacement)
	}

	updateInputDraft(text: string) {
		this.userContextManager.updateInputDraft(text)
	}

	async sendMessage(text: string): Promise<boolean> {
		await this.initialize()
		const normalizedText = text.trim()
		const session =
			this.getLoadedActiveSession() || (await this.createSession())
		if (!session) {
			return false
		}
		const runtime = this.runtimeStates.get(session.id)
		if (!normalizedText && runtime.pendingUserContext.length === 0) {
			return false
		}

		if (!this.selection.validateSessionSelection(session)) {
			return false
		}

		if (runtime.runState !== 'idle' || runtime.processing) {
			if (normalizedText) {
				runtime.pendingMessages.push(
					this.messageFactory.createPendingMessage(normalizedText),
				)
			}
			this.notify()
			return true
		}

		const pendingUserContext = runtime.pendingUserContext.splice(0)
		const preparedContext =
			await this.userContextManager.prepareUserContextForMessage(
				pendingUserContext,
			)
		this.messageFactory.appendUserMessage(
			this.messageFactory.getActiveFragment(session),
			normalizedText,
			session,
			preparedContext.dedupedItems.length > 0
				? preparedContext.dedupedItems
				: undefined,
			preparedContext.imageParts.length > 0
				? preparedContext.imageParts
				: undefined,
		)
		this.store.upsertSessionIndexItem(session, deriveTitle(session))
		runtime.runState = 'thinking'
		await this.store.persistSession(session)
		await this.store.persistMetaAndIndex()
		this.notify()
		await this.sessionProcessor.start(session.id)
		return true
	}

	createFragmentForActiveSession() {
		const session = this.getLoadedActiveSession()
		if (!session) {
			return
		}

		const runtime = this.runtimeStates.get(session.id)
		if (runtime.runState !== 'idle' || runtime.processing) {
			return
		}

		this.messageFactory.createFragment(session)
		void this.store.persistSession(session)
		this.notify()
	}

	async compressContext() {
		await this.initialize()
		const session = this.getLoadedActiveSession()
		if (!session) {
			return
		}

		const runtime = this.runtimeStates.get(session.id)
		if (runtime.runState !== 'idle' || runtime.processing) {
			return
		}
		if (!this.selection.validateSessionSelection(session)) {
			return
		}

		const sourceFragment = this.messageFactory.getActiveFragment(session)
		runtime.runState = 'compressing'
		this.notify()

		const task = (async () => {
			try {
				if (sourceFragment.messages.length > 0) {
					const provider = this.selection.getProviderOrThrow(session)
					await this.plugin.nutstoreLlmGatewayService.ensureProviderReady(
						provider,
					)
					const model = this.selection.getModelOrThrow(provider, session)
					const response = await generateAssistantTurn({
						provider,
						model: model.id,
						messages: [
							...sourceFragment.messages.map((item) => item.message),
							{
								role: 'user',
								content: toTextParts(COMPRESSION_PROMPT),
							},
						],
						tools: [],
						...session.inferenceParams,
					})

					if (
						this.state.deletedSessionIds.has(session.id) ||
						runtime.stopRequested
					) {
						return
					}

					const summary =
						messageToText(response.message).trim() || COMPRESSION_PROMPT
					const targetFragment = this.messageFactory.createFragment(session)
					targetFragment.summary = summary
					this.messageFactory.appendUserMessage(
						targetFragment,
						summary,
						session,
					)
					this.store.upsertSessionIndexItem(session, deriveTitle(session))
					await this.store.persistSession(session)
					await this.store.persistMetaAndIndex()
				}
			} catch (error) {
				const provider = getProviderById(
					this.plugin.settings.ai.providers,
					session.model?.providerId,
				)
				const model = getModelById(provider, session.model?.modelId)
				this.messageFactory.reportFatalError(
					session,
					extractErrorMessage(error, i18n.t('chatbox.requestFailed')),
					{
						providerId: provider?.id,
						providerName: provider?.name,
						modelId: model?.id,
						modelName: model?.name,
					},
					sourceFragment,
				)
				await this.store.persistSession(session)
			} finally {
				runtime.processing = undefined
				if (runtime.pendingMessages.length > 0) {
					runtime.runState = 'idle'
					this.notify()
					void this.sessionProcessor.start(session.id)
				} else {
					runtime.runState = 'idle'
					this.notify()
				}
			}
		})()

		runtime.processing = task
		await task
	}

	cancelTask(taskId: string) {
		const session = this.state.findLoadedSessionByTaskId(taskId)
		const rootTask = session?.tasks.find((item) => item.id === taskId)
		if (!session || !rootTask) {
			return
		}

		const terminalTasks = session.tasks.filter(
			(item) =>
				item.id === taskId ||
				this.taskManager.isTaskDescendantOf(session, item, taskId),
		)
		let changed = false

		for (const task of terminalTasks) {
			if (this.taskManager.isTaskTerminal(task)) {
				continue
			}
			mutateTaskRecord(
				task,
				toCancelledTask(
					task,
					task.id === taskId ? 'user_cancelled' : 'ancestor_cancelled',
					Date.now(),
					i18n.t('chatbox.task.cancelledSummary', { task: task.title }),
				),
			)
			this.taskManager.resolveTaskCompletion(
				task.id,
				this.taskManager.buildTaskToolPayload(task),
			)
			this.taskManager.cleanupTaskTracking(task.id)
			changed = true
		}

		if (changed) {
			void this.store.persistSession(session)
			this.notify()
			this.taskManager.startQueuedTasksForSession(session)
		}
	}

	stopActiveSessionRun() {
		const session = this.getLoadedActiveSession()
		if (!session) {
			return
		}

		void this.stopSessionRun(session)
	}

	deleteMessage(messageId: string) {
		this.messageOps.deleteMessage(messageId)
	}

	async recallMessage(
		messageId: string,
		options?: { restoreFiles?: boolean },
	): Promise<RecallMessageResult | void> {
		return this.messageOps.recallMessage(messageId, options)
	}

	async regenerateMessage(messageId: string) {
		await this.messageOps.regenerateMessage(messageId)
	}

	private async stopSessionRun(session: AISession) {
		const runtime = this.runtimeStates.get(session.id)
		if (
			runtime.runState !== 'thinking' &&
			runtime.runState !== 'waiting_for_tools' &&
			runtime.runState !== 'compressing'
		) {
			return
		}

		runtime.stopRequested = true

		const changed = this.taskManager.cancelAllNonTerminalTasks(
			session,
			'user_cancelled',
		)

		if (changed) {
			void this.store.persistSession(session)
			this.notify()
			this.taskManager.startQueuedTasksForSession(session)
		}

		await runtime.processing
	}

	private getLoadedActiveSession() {
		return this.state.activeSessionId
			? this.state.loadedSessions.get(this.state.activeSessionId)
			: undefined
	}

	private createEmptySession(): AISession {
		const { providerId, modelId } =
			this.selection.getInitialSelectionForNewSession()
		const now = Date.now()
		const fragment: ChatFragment = {
			id: createId('fragment'),
			createdAt: now,
			updatedAt: now,
			messages: [],
		}

		return {
			id: createId('session'),
			createdAt: now,
			updatedAt: now,
			model: providerId && modelId ? { providerId, modelId } : undefined,
			fragments: [fragment],
			activeFragmentId: fragment.id,
			tasks: [],
		}
	}
}
