import type { ModuleScope } from '~/modules/lifecycle'
import { guardAppIO } from '~/modules/guard-io'
import { getSessionSubagents, isTerminalAgent } from '~/ai/chat/domain'
import type { LanguageModelUsage } from 'ai'
import { Notice } from 'obsidian'
import {
	getModelById,
	getProviderById,
	listModels,
	listProviders,
	resolveInitialSelection,
} from '~/ai/catalog/config'
import {
	haveSameUserContextItems,
	type UserContextItem,
} from '~/ai/chat/context/user-context'
import { UserContextManager } from '~/ai/chat/context/user-context-manager'
import type { ChatSession, ChatSessionIndexItem } from '~/ai/chat/domain'
import { extractErrorMessage } from '~/ai/chat/error-utils'
import { exportSessionToMarkdownFile } from '~/ai/chat/messages/export-session'
import { MessageFactory } from '~/ai/chat/messages/message-factory'
import { MessageOps } from '~/ai/chat/messages/message-ops'
import { deriveTitle } from '~/ai/chat/messages/message-utils'
import {
	buildAgentMessages,
	createEmptyMasterAgent,
} from '~/ai/chat/messages/ui-message'
import { Notifier } from '~/ai/chat/notifier'
import {
	ChatState,
	type SessionRuntimeState,
} from '~/ai/chat/runtime/chat-state'
import {
	ContextCompressionFailedError,
	resolveContextWindow,
	resolveSummaryContext,
	runContextCompression,
} from '~/ai/chat/runtime/context-compression'
import {
	isSessionExecutionPending,
	RuntimeStates,
} from '~/ai/chat/runtime/runtime-state'
import { AgentRunner } from '~/ai/chat/runtime/agent-runner'
import { ContextCompactionCoordinator } from '~/ai/chat/runtime/context-compaction-coordinator'
import {
	createMasterTurnScheduler,
	getQueuedUserSubmissions,
} from '~/ai/chat/runtime/master-turn-scheduler'
import { Selection } from '~/ai/chat/runtime/selection'
import { SessionProcessor } from '~/ai/chat/runtime/session-processor'
import { TaskManager } from '~/ai/chat/runtime/task-manager'
import { ToolExecutor } from '~/ai/chat/runtime/tool-executor'
import { CHAT_INDEX_KEY, CHAT_META_KEY } from '~/ai/chat/prompts'
import { SessionsFileBackend } from '~/ai/chat/session/session-files'
import {
	SessionStore,
	type SessionLegacyStore,
} from '~/ai/chat/session/session-store'
import type { ChatModalMountTarget } from '~/ai/chat/ui/modal-mount'
import type {
	ChatboxProps,
	ChatProviderOption,
	RecallMessageResult,
} from '~/ai/chat/ui/types'
import {
	buildAgentViews,
	buildTimeline,
	collectOtherBusySessionIds,
} from '~/ai/chat/ui/view-projection'
import type { AIModelConfig, AIProviderConfig } from '~/ai/core/types'
import { BUILTIN_SKILLS } from '~/ai/skills/builtin'
import { SkillRepository } from '~/ai/skills/repository'
import { createAbortError, isAbortError } from '~/utils/abort'
import SessionExportModal from '~/components/SessionExportModal'
import i18n from '~/i18n'
import { chatMetaKV, chatSessionKV, type ChatMetaRecord } from '~/storage'
import { createUniqueWordId } from '~/utils/create-id'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'
import { BaseService } from './service.interface'

type ChatboxActionHandlers = Pick<
	ChatboxProps,
	| 'onNewSession'
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
	| 'onDeleteMessage'
	| 'onRegenerateMessage'
	| 'onRecallMessage'
	| 'onRecallHasReversibleOps'
	| 'onToggleSessionMcpServer'
>

type ChatboxViewRuntime = Pick<
	SessionRuntimeState,
	'runState' | 'draft' | 'scheduler'
>

type ViewSelectionState = {
	selectedProviderId?: string
	selectedModelId?: string
}

export default class ChatService extends BaseService {
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
	private readonly compactionCoordinator: ContextCompactionCoordinator
	private readonly skillRepository: SkillRepository

	constructor(
		private plugin: NutstorePlugin,
		private readonly scope: ModuleScope,
	) {
		super()
		const app = guardAppIO(plugin.app, scope.check, scope.track)
		this.skillRepository = new SkillRepository(app, BUILTIN_SKILLS, (name) =>
			plugin.settings.ai.disabledSkills.includes(name),
		)
		this.selection = new Selection(
			() => plugin.settings.ai,
			this.state,
			() => this.notify(),
			(session) => this.store.persistSession(session),
		)
		const legacyStore = this.createLegacySessionStore()
		this.store = new SessionStore(
			this.state,
			this.selection,
			new SessionsFileBackend(app),
			legacyStore,
			(sessionId, session) => {
				this.runtimeStates.resetExecution(sessionId)
				this.taskManager?.cleanupSessionAgentTracking(session)
			},
		)
		const memory = plugin.ai.memory.repository
		const contextSources = { skills: this.skillRepository, memory }
		this.toolExecutor = new ToolExecutor(
			app,
			() => plugin.settings.ai,
			this.state,
			this.runtimeStates,
			plugin.ai.mcp,
			{
				getSettingsSnapshot: () => {
					scope.check()
					return plugin.settings
				},
				updateSettings: (patch) => {
					scope.check()
					return plugin.settingsService.applySettingsPatch(patch)
				},
			},
			memory,
			scope,
			{
				service: plugin.ai.workspaces,
				persist: async (session) => {
					await this.store.persistSession(session)
					this.store.upsertSessionIndexItem(session)
					await this.store.persistMetaAndIndex()
					this.notify()
				},
			},
		)
		this.userContextManager = new UserContextManager(
			this.state,
			this.runtimeStates,
			() => this.notify(),
		)
		this.messageFactory = new MessageFactory(
			app,
			() => this.notify(),
			contextSources,
		)
		const gateway = plugin.ai.gateway
		const ensureProviderReady = async (provider: AIProviderConfig) => {
			scope.check()
			await gateway.ensureProviderReady(provider)
			scope.check()
		}
		const agentRunner = new AgentRunner(
			this.toolExecutor,
			this.store,
			this.messageFactory,
			() => this.notify(),
			app,
		)
		this.compactionCoordinator = new ContextCompactionCoordinator(
			this.store,
			this.messageFactory,
		)
		this.taskManager = new TaskManager(
			app,
			ensureProviderReady,
			this.state,
			this.selection,
			this.store,
			() => this.notify(),
			this.toolExecutor,
			this.messageFactory,
			agentRunner,
			this.compactionCoordinator,
		)
		this.toolExecutor.setAgentCommunication(this.taskManager)
		this.toolExecutor.setDispatchTaskHandler((params, origin) =>
			this.taskManager.dispatchTask(params, origin),
		)
		this.toolExecutor.setAppOpenHandler(async (appId) => {
			scope.check()
			const saved = await plugin.ai.openApp(appId)
			scope.check()
			if (!saved)
				throw new Error(
					'App opening is unavailable while the AI module is inactive',
				)
			return { appId, title: saved.manifest.title }
		})
		const reportTransientError = (message: string) => new Notice(message)
		this.messageOps = new MessageOps(
			app,
			this.state,
			this.runtimeStates,
			this.store,
			() => this.notify(),
			reportTransientError,
			this.messageFactory,
			(session) => this.selection.validateSessionSelection(session),
			(sessionId, messageId) =>
				this.sessionProcessor.enqueueRegenerate(sessionId, messageId),
			contextSources,
			{
				getSettingsSnapshot: () => {
					scope.check()
					return plugin.settings
				},
				updateSettings: (patch) => {
					scope.check()
					return plugin.settingsService.applySettingsPatch(patch)
				},
			},
			this.toolExecutor.getFileSystemManager(),
		)
		this.sessionProcessor = new SessionProcessor(
			ensureProviderReady,
			this.state,
			this.runtimeStates,
			this.store,
			() => this.notify(),
			this.selection,
			this.messageFactory,
			this.messageOps,
			this.userContextManager,
			agentRunner,
			this.compactionCoordinator,
			this.taskManager,
			reportTransientError,
		)
		this.taskManager.setUserInputPendingHandler((sessionId) =>
			this.sessionProcessor.hasQueuedUserInput(sessionId),
		)
		this.taskManager.setMasterAgentInputHandler((sessionId, input, origin) =>
			this.sessionProcessor.enqueueAgentInput(sessionId, input, origin),
		)
	}

	private notify() {
		if (this.scope.signal.aborted) return
		this.notifier.notify()
	}

	override onunload() {
		for (const [sessionId, session] of this.state.loadedSessions) {
			this.state.deletedSessionIds.add(sessionId)
			this.compactionCoordinator.cancel(sessionId)
			this.taskManager.cancelAllNonTerminalAgents(session)
			this.taskManager.cleanupSessionAgentTracking(session)
			this.runtimeStates.resetExecution(sessionId)
		}
	}

	/** Settle cancellation before another activation reads the same session files. */
	async suspend() {
		const pending = [...this.state.runtimeBySessionId.values()].map(
			(runtime) => runtime.processing,
		)
		const initialization = this.state.initialization
		this.onunload()
		await Promise.allSettled([...pending, initialization])
	}

	async initialize() {
		this.scope.check()
		if (this.state.initialization) {
			return this.state.initialization
		}

		this.state.initialization = this.initializeInternal()
			.then(() => {
				this.state.initialized = true
				this.notify()
			})
			.catch((error) => {
				this.state.initialization = undefined
				throw error
			})
		return this.state.initialization
	}

	private async initializeInternal() {
		const initialSession = await this.store.loadInitialSession()
		this.scope.check()
		if (initialSession) {
			this.taskManager.restoreMasterTaskContinuations(initialSession)
			await this.store.persistSession(initialSession)
		}

		if (!this.state.sessionIndex.length) {
			const session = await this.createEmptySession()
			this.scope.check()
			this.state.activeSessionId = session.id
			this.state.loadedSessions.set(session.id, session)
			this.store.upsertSessionIndexItem(session)
			await this.store.persistSession(session)
			await this.store.persistMetaAndIndex()
			return
		}
	}

	subscribe(listener: () => void) {
		return this.notifier.subscribe(listener)
	}

	async handleSettingsChanged() {
		if (this.scope.signal.aborted) return
		this.selection.syncPendingSelectionWithSettings()
		if (!this.state.initialization) {
			this.notify()
			return
		}

		await this.initialize()
		this.scope.check()
		const persisted: Promise<unknown>[] = []
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

	async listConfigurableSkills() {
		this.scope.check()
		await this.skillRepository.refresh()
		return this.skillRepository.discoverConfigurable()
	}

	getViewProps(): ChatboxProps {
		const activeSession = this.getLoadedActiveSession()
		const activeRuntime = this.getViewRuntime(activeSession)
		const selection = this.resolveViewSelection(activeSession)
		const selectedProvider = getProviderById(
			this.plugin.settings.ai.providers,
			selection.selectedProviderId,
		)
		const selectedModel = getModelById(
			selectedProvider,
			selection.selectedModelId,
		)
		const { usage, contextWindow } = this.resolveContextUsage(
			activeSession,
			selectedModel,
		)

		return {
			loading: !this.state.initialized,
			title: this.getActiveSessionTitle(),
			activeContextItems: [],
			sessionHistory: this.state.sessionIndex.map((item) => ({ ...item })),
			activeSessionId: this.state.activeSessionId,
			timeline: activeSession ? buildTimeline(activeSession) : [],
			agentsById: activeSession ? buildAgentViews(activeSession) : {},
			otherBusySessionIds: collectOtherBusySessionIds(
				this.state.loadedSessions,
				this.state.activeSessionId,
				(id) => this.runtimeStates.get(id),
			),
			providers: this.buildProviderOptions(),
			selectedProviderId: selection.selectedProviderId,
			selectedModelId: selection.selectedModelId,
			runState:
				activeSession &&
				(activeSession.subagents.master.status === 'waiting' ||
					(activeRuntime.runState === 'idle' &&
						getSessionSubagents(activeSession).some(
							(agent) => !isTerminalAgent(agent),
						)))
					? 'waiting_for_agents'
					: activeRuntime.runState,
			draft: {
				text: activeRuntime.draft.text,
				userContext: activeRuntime.draft.userContext.slice(),
			},
			pending: getQueuedUserSubmissions(activeRuntime).map((item) => ({
				text: item.text,
				userContext: item.userContext.slice(),
			})),
			canSend: !activeRuntime.draft.userContext.some(
				(item) => item.type === 'pending-context',
			),
			canCompress:
				!!activeSession &&
				activeRuntime.runState === 'idle' &&
				this.messageFactory.getActiveAgent(activeSession).timeline.length > 0,
			mcpServers: this.buildMcpServerOptions(activeSession),
			usage,
			contextWindow,
			...this.bindViewActions(),
		}
	}

	private buildMcpServerOptions(activeSession?: ChatSession) {
		const disabled = new Set(activeSession?.disabledMcpServers ?? [])
		return this.plugin.ai.mcp
			.getServerRuntimes()
			.filter((runtime) => runtime.enabled)
			.map((runtime) => ({
				name: runtime.name,
				connected: runtime.status === 'connected',
				toolCount: runtime.tools.length,
				disabled: disabled.has(runtime.name),
			}))
	}

	/**
	 * Resolves raw context usage stats for the active agent context: the most recent
	 * assistant `LanguageModelUsage` record, plus the active model's context
	 * window. Returns empty values when no usage data or model is available —
	 * the UI layer decides how to present that (e.g. hide the ring, show "—",
	 * keep the last known value, etc.). Keeping the raw usage object lets the
	 * UI surface outputTokens, cached tokens, and other details later without
	 * changing this service.
	 */
	private resolveContextUsage(
		activeSession?: ChatSession,
		model?: AIModelConfig,
	): { usage?: LanguageModelUsage; contextWindow?: number } {
		if (!activeSession || !model) return {}
		const contextWindow = resolveContextWindow(model)
		const agent = this.messageFactory.getActiveAgent(activeSession)
		const latestUsage = [...agent.timeline]
			.reverse()
			.find((item) => item.role === 'assistant' && item.metadata?.llm?.usage)
			?.metadata?.llm?.usage
		if (!latestUsage) return { contextWindow }
		return { usage: latestUsage, contextWindow }
	}

	private getViewRuntime(activeSession?: ChatSession): ChatboxViewRuntime {
		if (activeSession) {
			return this.runtimeStates.get(activeSession.id)
		}
		return {
			runState: 'idle',
			draft: {
				text: '',
				userContext: [] as UserContextItem[],
			},
			scheduler: createMasterTurnScheduler(),
		}
	}

	private resolveViewSelection(
		activeSession?: ChatSession,
	): ViewSelectionState {
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
			onCompressContext: () => this.compressContext(),
			onSwitchSession: (sessionId: string) =>
				void this.switchSession(sessionId),
			onExportSession: (sessionId, modalMountTarget) =>
				this.exportSession(sessionId, modalMountTarget),
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
			onDeleteMessage: (messageId: string) => this.deleteMessage(messageId),
			onRegenerateMessage: (messageId: string) => {
				void this.regenerateMessage(messageId)
			},
			onRecallMessage: (
				messageId: string,
				options?: { restoreFiles?: boolean },
			) => this.recallMessage(messageId, options),
			onRecallHasReversibleOps: (messageId: string) =>
				this.messageOps.recallMessageHasReversibleOps(messageId),
			onToggleSessionMcpServer: (serverName: string) =>
				void this.toggleSessionMcpServer(serverName),
		}
	}

	async toggleSessionMcpServer(serverName: string) {
		await this.initialize()
		this.scope.check()
		const session = this.getLoadedActiveSession()
		if (!session) {
			return
		}
		const disabled = new Set(session.disabledMcpServers ?? [])
		if (disabled.has(serverName)) {
			disabled.delete(serverName)
		} else {
			disabled.add(serverName)
		}
		session.disabledMcpServers = disabled.size > 0 ? [...disabled] : undefined
		this.notify()
		void this.store.persistSession(session).catch((error) => {
			logger.error('Failed to persist session MCP server toggles', error)
		})
	}

	async ensureSession() {
		await this.initialize()
		this.scope.check()
	}

	get workspaceState() {
		const session = this.getLoadedActiveSession()
		return {
			sessionId: session?.id,
			appId: session?.appId,
			busy:
				!session ||
				isSessionExecutionPending(this.runtimeStates.get(session.id)),
		}
	}
	get activeAppId() {
		return this.workspaceState.appId
	}

	async selectWorkspace(appId?: string) {
		await this.ensureSession()
		const session = this.getLoadedActiveSession()
		if (!session) throw new Error('No active chat')
		if (isSessionExecutionPending(this.runtimeStates.get(session.id)))
			throw new Error(
				'Wait for the current run to finish before switching workspace',
			)
		if (appId) await this.plugin.ai.apps.read(appId)
		if (isSessionExecutionPending(this.runtimeStates.get(session.id)))
			throw new Error(
				'Wait for the current run to finish before switching workspace',
			)
		this.scope.check()
		const previous = session.appId
		session.appId = appId
		try {
			await this.store.persistSession(session)
		} catch (error) {
			session.appId = previous
			throw error
		}
		this.store.upsertSessionIndexItem(session)
		await this.store.persistMetaAndIndex()
		this.notify()
	}

	async createSession() {
		await this.initialize()
		this.scope.check()
		const activeSession = this.getLoadedActiveSession()
		if (activeSession && this.isUntitledEmptyActiveSession(activeSession)) {
			return activeSession
		}
		const session = await this.createEmptySession()
		this.scope.check()
		this.state.loadedSessions.set(session.id, session)
		this.state.activeSessionId = session.id
		this.store.upsertSessionIndexItem(session, i18n.t('chatbox.newChat'), true)
		this.runtimeStates.get(session.id)
		this.notify()
		void this.store.persistSession(session).catch((error) => {
			logger.error('Failed to persist new chat session', error)
		})
		void this.store.persistMetaAndIndex().catch((error) => {
			logger.error('Failed to persist chat session index', error)
		})
		return session
	}

	async createDraftSession(text: string, userContext: UserContextItem[] = []) {
		await this.initialize()
		this.scope.check()
		const activeSession = this.getLoadedActiveSession()
		if (activeSession) {
			const draft = this.runtimeStates.get(activeSession.id).draft
			if (
				draft.text === text &&
				haveSameUserContextItems(draft.userContext, userContext)
			) {
				return activeSession
			}
		}

		const session = await this.createSession()
		this.scope.check()
		for (const item of userContext) {
			this.userContextManager.addUserContext(item)
		}
		this.userContextManager.updateInputDraft(text)
		this.notify()
		return session
	}

	async switchSession(sessionId: string) {
		await this.initialize()
		this.scope.check()
		if (!this.state.sessionIndex.some((item) => item.id === sessionId)) {
			return
		}

		const session = await this.store.loadSessionById(sessionId)
		this.scope.check()
		this.state.activeSessionId = sessionId
		this.taskManager.restoreMasterTaskContinuations(session)
		await this.store.persistSession(session)
		await this.store.persistMetaAndIndex()
		this.notify()
	}

	async deleteSession(sessionId: string) {
		await this.initialize()
		this.scope.check()
		if (!this.state.sessionIndex.some((item) => item.id === sessionId)) {
			return
		}

		this.state.deletedSessionIds.add(sessionId)
		this.compactionCoordinator.cancel(sessionId)
		const session = this.state.loadedSessions.get(sessionId)
		if (session) {
			await this.stopSessionRun(session, { waitForWorker: true })
			this.taskManager.cancelAllNonTerminalAgents(session)
			this.taskManager.cleanupSessionAgentTracking(session)
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
		await this.store.deleteSession(sessionId)
		await this.store.persistMetaAndIndex()
		this.notify()
		new Notice(i18n.t('chatbox.sessionDeleted'))
	}

	async exportSession(
		sessionId: string,
		modalMountTarget?: ChatModalMountTarget,
	) {
		await this.initialize()
		this.scope.check()
		if (!this.state.sessionIndex.some((item) => item.id === sessionId)) {
			new Notice(i18n.t('chatbox.errors.sessionNotFound'))
			return
		}

		const options = await SessionExportModal.open(
			this.plugin.app,
			modalMountTarget ?? this.getChatModalMountTarget(),
			this.scope.signal,
		)
		if (!options || this.scope.signal.aborted) {
			return
		}

		try {
			const session = await this.store.loadSessionById(sessionId)
			this.scope.check()
			const title =
				this.state.sessionIndex.find((item) => item.id === sessionId)?.title ||
				deriveTitle(session)
			const file = await exportSessionToMarkdownFile({
				vault: guardAppIO(this.plugin.app, this.scope.check, this.scope.track)
					.vault,
				manifestId: this.plugin.manifest.id,
				manifestVersion: this.plugin.manifest.version,
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

	getChatModalMountTarget() {
		return this.toolExecutor.getChatModalMountTarget()
	}

	private createLegacySessionStore(): SessionLegacyStore {
		return {
			listSessionKeys: async () => {
				try {
					return await chatSessionKV.keys()
				} catch {
					return []
				}
			},
			getSession: async (id) => {
				try {
					return await chatSessionKV.get(id)
				} catch {
					return undefined
				}
			},
			unsetSession: (id) => chatSessionKV.unset(id),
			getMeta: async () => {
				try {
					const [metaRaw, indexRaw] = await Promise.all([
						chatMetaKV.get(CHAT_META_KEY),
						chatMetaKV.get(CHAT_INDEX_KEY),
					])
					const meta = isChatMetaRecord(metaRaw) ? metaRaw : null
					const index = Array.isArray(indexRaw)
						? indexRaw.filter(isChatSessionIndexItem)
						: []
					return { meta, index }
				} catch {
					return { meta: null, index: [] }
				}
			},
		}
	}

	selectProvider(providerId: string) {
		this.scope.check()
		this.selection.selectProvider(providerId)
	}

	selectModel(modelId: string) {
		this.scope.check()
		this.selection.selectModel(modelId)
	}

	addUserContext(item: UserContextItem) {
		this.scope.check()
		this.userContextManager.addUserContext(item)
	}

	removeUserContext(index: number) {
		this.scope.check()
		this.userContextManager.removeUserContext(index)
	}

	resolvePendingContextItem(id: string, replacement: UserContextItem | null) {
		this.scope.check()
		this.userContextManager.resolvePendingContextItem(id, replacement)
	}

	updateInputDraft(text: string) {
		this.scope.check()
		this.userContextManager.updateInputDraft(text)
	}

	async sendMessage(
		text: string,
		activeContextItems: UserContextItem[] = [],
	): Promise<boolean> {
		await this.initialize()
		this.scope.check()
		const normalizedText = text.trim()
		const session =
			this.getLoadedActiveSession() || (await this.createSession())
		if (!session) {
			return false
		}
		const runtime = this.runtimeStates.get(session.id)
		const userContext = this.userContextManager.dedupeUserContextItems([
			...runtime.draft.userContext,
			...activeContextItems,
		])
		if (!normalizedText && userContext.length === 0) {
			return false
		}

		if (!this.selection.validateSessionSelection(session)) {
			return false
		}

		const turnId = this.sessionProcessor.enqueueUserSubmission(session.id, {
			text: normalizedText,
			userContext,
		})
		if (!turnId) return false
		runtime.draft = {
			text: '',
			userContext: [],
		}
		this.notify()
		return true
	}

	async compressContext() {
		await this.initialize()
		this.scope.check()
		const session = this.getLoadedActiveSession()
		if (!session) {
			return
		}

		const runtime = this.runtimeStates.get(session.id)
		if (isSessionExecutionPending(runtime)) {
			return
		}
		if (!this.selection.validateSessionSelection(session)) {
			return
		}

		const agent = this.messageFactory.getActiveAgent(session)
		this.compactionCoordinator.cancel(session.id, agent.id)
		runtime.runState = 'compressing'
		this.notify()

		const abortController = new AbortController()
		runtime.manualCompressionAbortController = abortController
		let task!: Promise<void>
		task = Promise.resolve().then(async () => {
			try {
				if (agent.timeline.length > 0) {
					const provider = this.selection.getProviderOrThrow(session)
					await this.plugin.ai.gateway.ensureProviderReady(provider)
					if (abortController.signal.aborted) {
						return
					}
					const model = this.selection.getModelOrThrow(provider, session)
					const isCurrentSelection = () =>
						session.model?.providerId === provider.id &&
						session.model?.modelId === model.id
					const result = await runContextCompression({
						provider,
						model,
						session,
						agent,
						store: this.store,
						messageFactory: this.messageFactory,
						...(await resolveSummaryContext(
							agent,
							session,
							model,
							this.toolExecutor,
							this.plugin.app,
						)),
						buildMessages: (messages, tools) =>
							buildAgentMessages(
								agent,
								tools,
								this.userContextManager,
								messages,
							),
						isCancelled: () =>
							abortController.signal.aborted ||
							this.state.deletedSessionIds.has(session.id) ||
							!isCurrentSelection(),
						abortSignal: abortController.signal,
					})
					if (result !== 'committed' && result !== 'cancelled') {
						throw new ContextCompressionFailedError(
							i18n.t('chatbox.errors.contextCompressionFailed'),
						)
					}
				}
			} catch (error) {
				if (isAbortError(error) && abortController.signal.aborted) {
					return
				}
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
					agent,
				)
				await this.store.persistSession(session)
			} finally {
				if (runtime.manualCompressionAbortController === abortController) {
					runtime.manualCompressionAbortController = undefined
				}
				if (runtime.processing === task) runtime.processing = undefined
				runtime.runState = 'idle'
				this.notify()
				if (!this.scope.signal.aborted && runtime.scheduler.queued.length > 0) {
					void this.sessionProcessor.start(session.id)
				}
			}
		})

		runtime.processing = task
		await task
	}

	stopActiveSessionRun() {
		const session = this.getLoadedActiveSession()
		if (!session) {
			return
		}

		void this.stopSessionRun(session)
	}

	deleteMessage(messageId: string) {
		this.scope.check()
		this.messageOps.deleteMessage(messageId)
	}

	async recallMessage(
		messageId: string,
		options?: { restoreFiles?: boolean },
	): Promise<RecallMessageResult | void> {
		this.scope.check()
		return this.messageOps.recallMessage(messageId, options)
	}

	async regenerateMessage(messageId: string) {
		this.scope.check()
		await this.messageOps.regenerateMessage(messageId)
	}

	private async stopSessionRun(
		session: ChatSession,
		options: { waitForWorker?: boolean } = {},
	) {
		const runtime = this.runtimeStates.get(session.id)
		if (await this.sessionProcessor.stopActiveTurn(session.id)) {
			if (options.waitForWorker) await runtime.processing
			return
		}
		if (this.taskManager.cancelAllNonTerminalAgents(session)) {
			await this.store.persistSession(session)
			this.notify()
		}
		const controller = runtime.manualCompressionAbortController
		if (!controller) return
		controller.abort(createAbortError('Stopped by user'))
		await runtime.processing
	}

	private getLoadedActiveSession() {
		return this.state.activeSessionId
			? this.state.loadedSessions.get(this.state.activeSessionId)
			: undefined
	}

	private isUntitledEmptyActiveSession(session: ChatSession) {
		const runtime = this.runtimeStates.get(session.id)
		return (
			this.getActiveSessionTitle() === i18n.t('chatbox.newChat') &&
			session.subagents.master.timeline.length === 0 &&
			runtime.draft.text.trim().length === 0 &&
			runtime.draft.userContext.length === 0 &&
			runtime.scheduler.queued.length === 0 &&
			!runtime.scheduler.active
		)
	}

	private async createEmptySession(): Promise<ChatSession> {
		const { providerId, modelId } =
			this.selection.getInitialSelectionForNewSession()
		const now = Date.now()
		return {
			schemaVersion: 2,
			id: await createUniqueWordId('session', (id) =>
				this.state.sessionIndex.some((item) => item.id === id),
			),
			createdAt: now,
			updatedAt: now,
			model: providerId && modelId ? { providerId, modelId } : undefined,
			subagents: { master: createEmptyMasterAgent(now) },
		}
	}
}

function isChatMetaRecord(value: unknown): value is ChatMetaRecord {
	return (
		!!value &&
		typeof value === 'object' &&
		Array.isArray((value as ChatMetaRecord).orderedSessionIds)
	)
}

function isChatSessionIndexItem(value: unknown): value is ChatSessionIndexItem {
	return (
		!!value &&
		typeof value === 'object' &&
		typeof (value as ChatSessionIndexItem).id === 'string' &&
		typeof (value as ChatSessionIndexItem).title === 'string' &&
		typeof (value as ChatSessionIndexItem).createdAt === 'number' &&
		typeof (value as ChatSessionIndexItem).updatedAt === 'number'
	)
}
