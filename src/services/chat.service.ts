import { APICallError } from 'ai'
import { normalizePath, Notice } from 'obsidian'
import {
	getFirstModel,
	getModelById,
	getProviderById,
	listModels,
	listProviders,
	resolveInitialSelection,
} from '~/ai/config'
import { createPermissionGuard } from '~/ai/permission-guard'
import { assertProviderUsable, generateAssistantTurn } from '~/ai/runtime'
import {
	REPEATED_TOOL_CALL_THRESHOLD,
	ToolCallRepeatState,
	updateToolCallRepeatState,
} from '~/ai/tool-call-repeat'
import { createAITools } from '~/ai/tools'
import {
	AIMessage,
	AIMessageContentPart,
	AIMessageRecord,
	AIProviderConfig,
	AISession,
	AITaskRecord,
	AIToolCall,
	AIToolDefinition,
	AIToolExecutionContext,
	ToolExecutionResult,
} from '~/ai/types'
import type {
	AssistantModelMessage,
	ImagePart,
	TextPart,
	ToolCallPart,
} from 'ai'
import {
	ChatFragment,
	ChatMessage,
	ChatPendingMessage,
	ChatRunState,
	ChatSessionIndexItem,
	ChatUserMessage,
	cloneMessage,
	cloneMessageRecord,
	cloneReversibleToolOp,
	cloneSession,
	createQueuedTask,
	createRunningTask,
	isTerminalTask,
	mutateTaskRecord,
	QueuedChatTask,
	toCancelledTask,
	toCompletedTask,
	toFailedTask,
	toRunningTask,
} from '~/chat/domain'
import { projectFragmentMessageGroups } from '~/chat/display-blocks'
import { exportSessionToMarkdownFile } from '~/chat/export-session'
import { resolveChatModalMountTarget } from '~/chat/modal-mount'
import {
	decodeReversibleFileSnapshot,
	hasCompressedFileContent,
} from '~/chat/reversible-content'
import {
	blobToDataUrl,
	ensureUserContextItemHash,
	formatUserContext,
	getUserContextItemHash,
	type UserContextItem,
} from '~/chat/user-context'
import {
	captureWorkspaceContexts,
	computeChangedContexts,
	formatAdditionalContext,
} from '~/chat/workspace-context'
import type {
	ChatboxProps,
	ChatProviderOption,
	RecallMessageResult,
} from '~/chatbox/types'
import SessionExportModal from '~/components/SessionExportModal'
import i18n from '~/i18n'
import { chatMetaKV, chatSessionKV, type ChatMetaRecord } from '~/storage'
import createId from '~/utils/create-id'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'

const MAX_TASK_DEPTH = 2
const MAX_CONCURRENT_TASKS_PER_SESSION = 3
const CHAT_META_KEY = 'chat_meta'
const CHAT_INDEX_KEY = 'chat_index'
const INTERRUPTED_TASK_CANCEL_REASON = 'interrupted_by_restart'
const COMPRESSION_PROMPT = [
	'Summarize the conversation above for continuation in a fresh context.',
	'Return a compact but information-dense handoff covering:',
	'1. Confirmed facts and file paths.',
	'2. Decisions already made.',
	'3. Constraints, caveats, and user preferences.',
	'4. Unfinished work and the next concrete step.',
	'5. Any tool results that remain relevant.',
	'Write the summary as a user message that can be pasted into a new chat segment.',
].join(' ')

interface ResolvedToolResult {
	payload: string | Record<string, unknown>
	isError: boolean
	reversibleOps?: AIMessageRecord['reversibleOps']
}

interface DeferredTaskCompletion {
	promise: Promise<Record<string, unknown>>
	resolve: (payload: Record<string, unknown>) => void
	settled: boolean
}

interface AgentRunResult {
	status: 'completed' | 'failed' | 'cancelled'
	summary?: string
	error?: string
	failureStage?: string
	sourceCount: number
}

interface SessionRuntimeState {
	runState: ChatRunState
	processing?: Promise<void>
	stopRequested?: boolean
	pendingMessages: ChatPendingMessage[]
	pendingUserContext: UserContextItem[]
	pendingInputDraft: string
}

function toTextParts(text: string): TextPart[] {
	return [{ type: 'text', text }]
}

function migrateMessageFromV0(msg: unknown): ChatMessage {
	if (!msg || typeof msg !== 'object') {
		return msg as ChatMessage
	}
	const m = msg as Record<string, unknown>
	const role = m.role as string

	if (role === 'assistant') {
		const oldContent = Array.isArray(m.content) ? m.content : []
		const oldToolCalls = Array.isArray(m.tool_calls) ? m.tool_calls : []
		const contentParts: unknown[] = oldContent.map((part: unknown) => {
			const p = part as Record<string, unknown>
			if (p.type === 'image_url' && p.image_url) {
				const iu = p.image_url as Record<string, unknown>
				return { type: 'image', image: iu.url }
			}
			if (p.type === 'unknown') {
				return { type: 'text', text: JSON.stringify(p.value) }
			}
			return { type: 'text', text: p.text ?? '' }
		})
		const toolCallParts = oldToolCalls.map((tc: unknown) => {
			const t = tc as Record<string, unknown>
			const fn = (t.function ?? {}) as Record<string, unknown>
			let input: unknown = {}
			try {
				input = JSON.parse((fn.arguments as string) || '{}')
			} catch (_e) {
				// keep default empty object
			}
			return {
				type: 'tool-call',
				toolCallId: t.id,
				toolName: fn.name,
				input,
			}
		})
		return {
			role: 'assistant',
			content: [...contentParts, ...toolCallParts],
		} as ChatMessage
	}

	if (role === 'tool') {
		const oldContent = Array.isArray(m.content) ? m.content : []
		const textValue = oldContent
			.filter((p: unknown) => (p as Record<string, unknown>).type === 'text')
			.map((p: unknown) => (p as Record<string, string>).text)
			.join('\n')
		return {
			role: 'tool',
			content: [
				{
					type: 'tool-result',
					toolCallId: m.tool_call_id as string,
					toolName: m.name as string,
					output: { type: 'text', value: textValue },
				},
			],
		} as ChatMessage
	}

	if (role === 'user') {
		const oldContent = Array.isArray(m.content) ? m.content : []
		const parts = oldContent.map((part: unknown) => {
			const p = part as Record<string, unknown>
			if (p.type === 'image_url' && p.image_url) {
				const iu = p.image_url as Record<string, unknown>
				return { type: 'image', image: iu.url }
			}
			if (p.type === 'unknown') {
				return { type: 'text', text: JSON.stringify(p.value) }
			}
			return { type: 'text', text: p.text ?? '' }
		})
		return { role: 'user', content: parts } as ChatMessage
	}

	return msg as ChatMessage
}

function needsV0Migration(msg: unknown): boolean {
	if (!msg || typeof msg !== 'object') return false
	const m = msg as Record<string, unknown>
	return (
		(m.role === 'assistant' && 'tool_calls' in m) ||
		(m.role === 'tool' && 'tool_call_id' in m)
	)
}

function cloneUserContextItem(item: UserContextItem): UserContextItem {
	const normalized = ensureUserContextItemHash(item)
	if (normalized.type === 'file' || normalized.type === 'folder') {
		return { ...normalized }
	}
	if (normalized.type === 'image') {
		return { ...normalized }
	}
	return {
		hash: normalized.hash,
		type: 'selection',
		filePath: normalized.filePath,
		range: {
			from: { ...normalized.range.from },
			to: { ...normalized.range.to },
		},
		selectedText: normalized.selectedText,
	}
}

function cloneUserContextItems(items: UserContextItem[]) {
	return items.map(cloneUserContextItem)
}

function messageToText(message: Pick<ChatMessage, 'content'> | AIMessage) {
	if (!message.content) {
		return ''
	}
	if (typeof message.content === 'string') {
		return message.content
	}
	return (message.content as Array<{ type: string; text?: string }>)
		.filter((part) => part.type === 'text')
		.map((part) => part.text ?? '')
		.join('\n')
}

function getAssistantToolCalls(
	message: ChatMessage,
): ToolCallPart[] | undefined {
	if (message.role !== 'assistant' || !Array.isArray(message.content)) {
		return undefined
	}
	const calls = (message.content as Array<{ type: string }>).filter(
		(p): p is ToolCallPart => p.type === 'tool-call',
	)
	return calls.length > 0 ? calls : undefined
}

function getPathDepth(path: string) {
	return path.split('/').filter(Boolean).length
}

function getParentVaultPaths(path: string) {
	const parts = path.split('/').filter(Boolean)
	const parents: string[] = []
	let current = ''
	for (let index = 0; index < parts.length - 1; index += 1) {
		current = current ? `${current}/${parts[index]}` : parts[index]
		parents.push(current)
	}
	return parents
}

function normalizeReversibleVaultPath(path: string) {
	const trimmed = path.trim()
	if (!trimmed) {
		return ''
	}
	const normalized = normalizePath(trimmed.replace(/^\/+/, ''))
	return normalized === '.' ? '' : normalized
}

function normalizeReversibleToolOpRecord(
	op: NonNullable<AIMessageRecord['reversibleOps']>[number],
) {
	const normalizedPath = normalizeReversibleVaultPath(op.vaultPath)
	if (!normalizedPath) {
		return null
	}
	if (op.operation === 'update') {
		if (
			!hasCompressedFileContent(op.before) &&
			typeof op.before.contentBase64 !== 'string'
		) {
			return null
		}
	}
	if (op.operation === 'delete' && op.before.kind === 'file') {
		if (
			!hasCompressedFileContent(op.before) &&
			typeof op.before.contentBase64 !== 'string'
		) {
			return null
		}
	}
	const cloned = cloneReversibleToolOp(op)
	return {
		...cloned,
		vaultPath: normalizedPath,
	}
}

function isVaultFolder(
	target: unknown,
): target is { path: string; children: unknown[] } {
	return !!target && typeof target === 'object' && 'children' in target
}

function isVaultFile(target: unknown): target is { path: string } {
	return !!target && typeof target === 'object' && !('children' in target)
}

function deriveTitle(session: Pick<AISession, 'fragments'>) {
	for (const fragment of session.fragments) {
		const firstUser = fragment.messages.find(
			(item) => item.message.role === 'user',
		)
		const content = firstUser ? messageToText(firstUser.message).trim() : ''
		if (content) {
			return content
		}
	}
	return i18n.t('chatbox.newChat')
}

function createVaultToolGuidance() {
	return [
		'For ambiguous user requests, you may broaden exploration when needed to improve answer quality.',
		'Base answers on evidence from tool results, and cite key file paths or outputs.',
		'Avoid unbounded exploration, but do not stop when evidence is still weak or conflicting.',
		'Stop when evidence is sufficient for a grounded answer, or when further tool use is clearly repetitive.',
	].join(' ')
}

function createMainSystemPrompt(maxDepth: number) {
	return [
		'You are an Obsidian chat assistant with access to vault tools.',
		'Use vault tools directly for focused file operations.',
		'Use bash when shell-style workflows are more efficient.',
		createVaultToolGuidance(),
		`Use the spawn tool only for large independent tasks that should run in the background. Maximum task depth is ${maxDepth}.`,
		'You may receive workspace context in <AdditionalContext> XML blocks prepended to user messages. Each block contains only the workspace fields that changed since the previous message (a delta). For changed fields, the value is the complete current state — for example, if openFiles shrinks, files no longer in the list have been closed. Silently update your understanding of the workspace; do not mention or quote the XML structure itself.',
	].join(' ')
}

function createSubagentSystemPrompt(canSpawn: boolean) {
	return [
		'You are a focused background subagent working inside an Obsidian vault.',
		createVaultToolGuidance(),
		canSpawn &&
			'Use spawn when this task must be split into smaller independent background tasks.',
		'When you finish, return a concise final answer. If the task fails, explain the failure clearly.',
	]
		.filter(Boolean)
		.join(' ')
}

function extractErrorMessage(error: unknown, fallback: string): string {
	if (APICallError.isInstance(error) && error.responseBody != null) {
		return typeof error.responseBody === 'string'
			? error.responseBody
			: JSON.stringify(error.responseBody)
	}
	return error instanceof Error ? error.message : fallback
}

export default class ChatService {
	private readonly loadedSessions = new Map<string, AISession>()
	private readonly autoApproveRequestsBySessionId = new Map<
		string,
		Set<string>
	>()
	private sessionIndex: ChatSessionIndexItem[] = []
	private readonly deletedSessionIds = new Set<string>()
	private pendingProviderId?: string
	private pendingModelId?: string
	private activeSessionId?: string
	private listeners = new Set<() => void>()
	private readonly runtimeBySessionId = new Map<string, SessionRuntimeState>()
	private readonly taskModelSelection = new Map<
		string,
		{ providerId: string; modelId: string } | undefined
	>()
	private readonly pendingTaskCompletions = new Map<
		string,
		DeferredTaskCompletion
	>()
	private chatModalHostEl?: HTMLElement
	private initialization?: Promise<void>

	constructor(private plugin: NutstorePlugin) {}

	async initialize() {
		if (this.initialization) {
			return this.initialization
		}

		this.initialization = this.initializeInternal().catch((error) => {
			this.initialization = undefined
			throw error
		})
		return this.initialization
	}

	private async initializeInternal() {
		await this.loadSessionIndex()

		if (this.sessionIndex.length === 0) {
			const session = this.createEmptySession()
			this.activeSessionId = session.id
			this.loadedSessions.set(session.id, session)
			this.upsertSessionIndexItem(session)
			await this.persistSession(session)
			await this.persistMetaAndIndex()
			return
		}

		const fallbackSessionId =
			this.activeSessionId &&
			this.sessionIndex.some((item) => item.id === this.activeSessionId)
				? this.activeSessionId
				: this.sessionIndex[0]?.id
		this.activeSessionId = fallbackSessionId
		if (fallbackSessionId) {
			await this.loadSessionById(fallbackSessionId)
			await this.persistMetaAndIndex()
		}
	}

	subscribe(listener: () => void) {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	async handleSettingsChanged() {
		await this.initialize()
		const persisted: Promise<unknown>[] = []
		this.syncPendingSelectionWithSettings()
		for (const session of this.loadedSessions.values()) {
			if (this.sanitizeSessionSelection(session)) {
				persisted.push(this.persistSession(session))
			}
		}

		if (persisted.length > 0) {
			await Promise.all(persisted)
		}
		this.notify()
	}

	getViewProps(): ChatboxProps {
		const activeSession = this.getLoadedActiveSession()
		const activeRuntime = activeSession
			? this.getRuntime(activeSession.id)
			: {
					runState: 'idle' as const,
					pendingMessages: [],
					pendingUserContext: [] as UserContextItem[],
					pendingInputDraft: '',
				}
		const fallbackSelection = resolveInitialSelection(
			this.plugin.settings.ai.providers,
			this.plugin.settings.ai.defaultModel,
		)
		const emptyStateSelection = this.getEmptyStateSelection()
		const providerIdForView = activeSession
			? activeSession.model?.providerId
			: emptyStateSelection.providerId || fallbackSelection.providerId
		const modelIdForView = activeSession
			? activeSession.model?.modelId
			: emptyStateSelection.modelId || fallbackSelection.modelId
		const selectedProvider = getProviderById(
			this.plugin.settings.ai.providers,
			providerIdForView,
		)
		const selectedModel = getModelById(selectedProvider, modelIdForView)

		return {
			title:
				this.sessionIndex.find((item) => item.id === this.activeSessionId)
					?.title || i18n.t('chatbox.newChat'),
			sessionHistory: this.sessionIndex.map((item) => ({
				...item,
			})),
			activeSessionId: this.activeSessionId,
			timeline: activeSession ? this.buildTimeline(activeSession) : [],
			currentSessionTasks: activeSession
				? activeSession.tasks
						.slice()
						.sort((left, right) => right.createdAt - left.createdAt)
				: [],
			otherSessionTasks: this.collectOtherSessionTasks(),
			otherBusySessionIds: this.collectOtherBusySessionIds(),
			providers: listProviders(
				this.plugin.settings.ai.providers,
			).map<ChatProviderOption>((provider) => ({
				id: provider.id,
				name: provider.name || i18n.t('settings.ai.unnamedProvider'),
				models: listModels(provider).map((model) => ({
					id: model.id,
					name: model.name || i18n.t('settings.ai.unnamedModel'),
				})),
			})),
			selectedProviderId: selectedProvider?.id,
			selectedModelId: selectedModel?.id,
			runState: activeRuntime.runState,
			pendingMessages: activeRuntime.pendingMessages.map((item) => ({
				...item,
			})),
			pendingUserContext: activeRuntime.pendingUserContext.slice(),
			pendingInputDraft: activeRuntime.pendingInputDraft,
			canSend: true,
			canCreateFragment: !!activeSession && activeRuntime.runState === 'idle',
			canCompress:
				!!activeSession &&
				activeRuntime.runState === 'idle' &&
				this.getActiveFragment(activeSession).messages.length > 0,
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
				this.recallMessageHasReversibleOps(messageId),
		}
	}

	async ensureSession() {
		await this.initialize()
	}

	async createSession() {
		await this.initialize()
		const session = this.createEmptySession()
		this.loadedSessions.set(session.id, session)
		this.activeSessionId = session.id
		this.upsertSessionIndexItem(session, i18n.t('chatbox.newChat'), true)
		this.getRuntime(session.id)
		await this.persistSession(session)
		await this.persistMetaAndIndex()
		this.notify()
		return session
	}

	async switchSession(sessionId: string) {
		await this.initialize()
		if (!this.sessionIndex.some((item) => item.id === sessionId)) {
			return
		}

		await this.loadSessionById(sessionId)
		this.activeSessionId = sessionId
		await this.persistMetaAndIndex()
		this.notify()
	}

	async deleteSession(sessionId: string) {
		await this.initialize()
		if (!this.sessionIndex.some((item) => item.id === sessionId)) {
			return
		}

		this.deletedSessionIds.add(sessionId)
		const session = this.loadedSessions.get(sessionId)
		if (session) {
			await this.stopSessionRun(session)
			this.cancelAllNonTerminalTasks(session, 'user_cancelled')
			this.cleanupSessionTaskTracking(session)
		}

		this.sessionIndex = this.sessionIndex.filter(
			(item) => item.id !== sessionId,
		)
		if (this.activeSessionId === sessionId) {
			this.activeSessionId = this.sessionIndex[0]?.id
			if (this.activeSessionId) {
				await this.loadSessionById(this.activeSessionId)
			}
		}

		this.loadedSessions.delete(sessionId)
		this.runtimeBySessionId.delete(sessionId)
		this.autoApproveRequestsBySessionId.delete(sessionId)
		await chatSessionKV.unset(sessionId)
		await this.persistMetaAndIndex()
		this.notify()
		new Notice(i18n.t('chatbox.sessionDeleted'))
	}

	async exportSession(sessionId: string) {
		await this.initialize()
		if (!this.sessionIndex.some((item) => item.id === sessionId)) {
			new Notice(i18n.t('chatbox.errors.sessionNotFound'))
			return
		}

		const options = await SessionExportModal.open(
			this.plugin.app,
			this.getChatModalMountTarget(),
		)
		if (!options) {
			return
		}

		try {
			const session = await this.loadSessionById(sessionId)
			const title =
				this.sessionIndex.find((item) => item.id === sessionId)?.title ||
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
		this.chatModalHostEl = rootEl?.isConnected ? rootEl : undefined
	}

	selectProvider(providerId: string) {
		const session = this.getLoadedActiveSession()
		if (!session) {
			if (!providerId) {
				this.pendingProviderId = undefined
				this.pendingModelId = undefined
				this.notify()
				return
			}

			const provider = getProviderById(
				this.plugin.settings.ai.providers,
				providerId,
			)
			if (!provider) {
				return
			}

			this.pendingProviderId = provider.id
			this.pendingModelId = getFirstModel(provider)?.id
			this.notify()
			return
		}

		if (this.getRuntime(session.id).runState !== 'idle') {
			return
		}
		if (!providerId) {
			session.model = undefined
			void this.persistSession(session)
			this.notify()
			return
		}

		const provider = getProviderById(
			this.plugin.settings.ai.providers,
			providerId,
		)
		if (!provider) {
			return
		}

		const firstModelId = getFirstModel(provider)?.id
		session.model = firstModelId
			? { providerId: provider.id, modelId: firstModelId }
			: undefined
		void this.persistSession(session)
		this.notify()
	}

	selectModel(modelId: string) {
		const session = this.getLoadedActiveSession()
		if (!session) {
			if (!modelId) {
				this.pendingModelId = undefined
				this.notify()
				return
			}

			const provider = getProviderById(
				this.plugin.settings.ai.providers,
				this.pendingProviderId,
			)
			const model = getModelById(provider, modelId)
			if (!model) {
				return
			}

			this.pendingModelId = model.id
			this.notify()
			return
		}

		if (this.getRuntime(session.id).runState !== 'idle') {
			return
		}
		if (!modelId) {
			session.model = undefined
			void this.persistSession(session)
			this.notify()
			return
		}

		const provider = getProviderById(
			this.plugin.settings.ai.providers,
			session.model?.providerId,
		)
		const model = getModelById(provider, modelId)
		if (!model || !provider) {
			return
		}

		session.model = { providerId: provider.id, modelId: model.id }
		void this.persistSession(session)
		this.notify()
	}

	addUserContext(item: UserContextItem) {
		const session = this.getLoadedActiveSession()
		if (!session) return
		const runtime = this.getRuntime(session.id)
		const normalized = cloneUserContextItem(item)
		const hash = getUserContextItemHash(normalized)
		if (
			runtime.pendingUserContext.some(
				(contextItem) => contextItem.hash === hash,
			)
		) {
			return
		}
		runtime.pendingUserContext.push(normalized)
		this.notify()
	}

	removeUserContext(index: number) {
		const session = this.getLoadedActiveSession()
		if (!session) return
		const runtime = this.getRuntime(session.id)
		runtime.pendingUserContext.splice(index, 1)
		this.notify()
	}

	updateInputDraft(text: string) {
		const session = this.getLoadedActiveSession()
		if (!session) return
		const runtime = this.getRuntime(session.id)
		runtime.pendingInputDraft = text
	}

	async sendMessage(text: string): Promise<boolean> {
		await this.initialize()
		const normalizedText = text.trim()
		const session =
			this.getLoadedActiveSession() || (await this.createSession())
		if (!session) {
			return false
		}
		const runtime = this.getRuntime(session.id)
		if (!normalizedText && runtime.pendingUserContext.length === 0) {
			return false
		}

		if (!this.validateSessionSelection(session)) {
			return false
		}

		if (runtime.runState !== 'idle' || runtime.processing) {
			if (normalizedText) {
				runtime.pendingMessages.push(this.createPendingMessage(normalizedText))
			}
			this.notify()
			return true
		}

		const pendingUserContext = runtime.pendingUserContext.splice(0)
		const preparedContext =
			await this.prepareUserContextForMessage(pendingUserContext)
		this.appendUserMessage(
			this.getActiveFragment(session),
			normalizedText,
			session,
			preparedContext.dedupedItems.length > 0
				? preparedContext.dedupedItems
				: undefined,
			preparedContext.imageParts.length > 0
				? preparedContext.imageParts
				: undefined,
		)
		this.upsertSessionIndexItem(session, deriveTitle(session))
		runtime.runState = 'thinking'
		await this.persistSession(session)
		await this.persistMetaAndIndex()
		this.notify()
		await this.startSessionProcessor(session.id)
		return true
	}

	createFragmentForActiveSession() {
		const session = this.getLoadedActiveSession()
		if (!session) {
			return
		}

		const runtime = this.getRuntime(session.id)
		if (runtime.runState !== 'idle' || runtime.processing) {
			return
		}

		this.createFragment(session)
		void this.persistSession(session)
		this.notify()
	}

	async compressContext() {
		await this.initialize()
		const session = this.getLoadedActiveSession()
		if (!session) {
			return
		}

		const runtime = this.getRuntime(session.id)
		if (runtime.runState !== 'idle' || runtime.processing) {
			return
		}
		if (!this.validateSessionSelection(session)) {
			return
		}

		const sourceFragment = this.getActiveFragment(session)
		runtime.runState = 'compressing'
		this.notify()

		const task = (async () => {
			try {
				if (sourceFragment.messages.length > 0) {
					const provider = this.getProviderOrThrow(session)
					await this.plugin.nutstoreLlmGatewayService.ensureProviderReady(
						provider,
					)
					const model = this.getModelOrThrow(provider, session)
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

					if (this.deletedSessionIds.has(session.id) || runtime.stopRequested) {
						return
					}

					const summary =
						messageToText(response.message).trim() || COMPRESSION_PROMPT
					const targetFragment = this.createFragment(session)
					targetFragment.summary = summary
					this.appendUserMessage(targetFragment, summary, session)
					this.upsertSessionIndexItem(session, deriveTitle(session))
					await this.persistSession(session)
					await this.persistMetaAndIndex()
				}
			} catch (error) {
				const provider = getProviderById(
					this.plugin.settings.ai.providers,
					session.model?.providerId,
				)
				const model = getModelById(provider, session.model?.modelId)
				this.reportFatalError(
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
				await this.persistSession(session)
			} finally {
				runtime.processing = undefined
				if (runtime.pendingMessages.length > 0) {
					runtime.runState = 'idle'
					this.notify()
					void this.startSessionProcessor(session.id)
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
		const session = this.findLoadedSessionByTaskId(taskId)
		const rootTask = session?.tasks.find((item) => item.id === taskId)
		if (!session || !rootTask) {
			return
		}

		const terminalTasks = session.tasks.filter(
			(item) =>
				item.id === taskId || this.isTaskDescendantOf(session, item, taskId),
		)
		let changed = false

		for (const task of terminalTasks) {
			if (this.isTaskTerminal(task)) {
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
			this.resolveTaskCompletion(task.id, this.buildTaskToolPayload(task))
			this.cleanupTaskTracking(task.id)
			changed = true
		}

		if (changed) {
			void this.persistSession(session)
			this.notify()
			this.startQueuedTasksForSession(session)
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
		const session = this.getLoadedActiveSession()
		if (!session) {
			return
		}
		const runtime = this.getRuntime(session.id)
		if (runtime.runState !== 'idle') {
			return
		}
		const fragment = this.getActiveFragment(session)
		const idx = fragment.messages.findIndex((record) => record.id === messageId)
		if (idx === -1) {
			return
		}
		const target = fragment.messages[idx]
		if (target.message.role === 'user') {
			// Delete this user message and everything that follows until the next user message
			// (covers assistant replies, tool calls, and tool result messages in any chain depth)
			let endIdx = idx + 1
			while (
				endIdx < fragment.messages.length &&
				fragment.messages[endIdx].message.role !== 'user'
			) {
				endIdx++
			}
			fragment.messages.splice(idx, endIdx - idx)
		} else if (target.message.role === 'tool') {
			const firstPart = Array.isArray(target.message.content)
				? (
						target.message.content as Array<{
							type: string
							toolCallId?: string
						}>
					)[0]
				: undefined
			const toolCallId =
				firstPart?.type === 'tool-result' ? firstPart.toolCallId : undefined
			// Remove the matching tool call from the nearest preceding assistant message
			for (let i = idx - 1; i >= 0; i--) {
				const record = fragment.messages[i]
				if (record.message.role === 'user') break
				if (
					record.message.role === 'assistant' &&
					Array.isArray(record.message.content)
				) {
					const content = record.message.content as Array<
						{ type: string } & Partial<ToolCallPart>
					>
					if (
						content.some(
							(p) => p.type === 'tool-call' && p.toolCallId === toolCallId,
						)
					) {
						record.message = {
							...record.message,
							content: content.filter(
								(p) => !(p.type === 'tool-call' && p.toolCallId === toolCallId),
							),
						} as AssistantModelMessage
						break
					}
				}
			}
			fragment.messages.splice(idx, 1)
		} else {
			fragment.messages.splice(idx, 1)
		}
		void this.persistSession(session)
		this.notify()
	}

	async recallMessage(
		messageId: string,
		options?: { restoreFiles?: boolean },
	): Promise<RecallMessageResult | void> {
		const session = this.getLoadedActiveSession()
		if (!session) {
			return
		}
		const runtime = this.getRuntime(session.id)
		if (runtime.runState !== 'idle') {
			return
		}
		const fragment = this.getActiveFragment(session)
		const idx = fragment.messages.findIndex((record) => record.id === messageId)
		if (idx === -1) {
			return
		}
		const recalledMessage = fragment.messages[idx]
		const recalledText =
			recalledMessage.message.role === 'user'
				? messageToText(recalledMessage.message)
				: ''
		const recalledUserContext = cloneUserContextItems(
			recalledMessage.userContext ?? [],
		)
		const recallRange = fragment.messages.slice(idx)
		const reversibleOps = recallRange.flatMap(
			(record) => record.reversibleOps ?? [],
		)
		try {
			if (options?.restoreFiles) {
				await this.restoreFilesForRecall(reversibleOps)
			}
			fragment.messages.splice(idx)
			runtime.pendingUserContext = recalledUserContext
			await this.persistSession(session)
			this.notify()
			return {
				text: recalledText,
				userContext: cloneUserContextItems(recalledUserContext),
			}
		} catch (error) {
			logger.error(error)
			new Notice(error instanceof Error ? error.message : String(error))
		}
	}

	private recallMessageHasReversibleOps(messageId: string): boolean {
		const session = this.getLoadedActiveSession()
		if (!session) {
			return false
		}
		const fragment = this.getActiveFragment(session)
		const idx = fragment.messages.findIndex((record) => record.id === messageId)
		if (idx === -1) {
			return false
		}
		return fragment.messages
			.slice(idx)
			.some((record) => Boolean(record.reversibleOps?.length))
	}

	async regenerateMessage(messageId: string) {
		const session = this.getLoadedActiveSession()
		if (!session || !this.validateSessionSelection(session)) {
			return
		}
		const runtime = this.getRuntime(session.id)
		if (runtime.runState !== 'idle' || runtime.processing) {
			return
		}
		const fragment = this.getActiveFragment(session)
		const idx = fragment.messages.findIndex((record) => record.id === messageId)
		if (idx === -1) {
			return
		}
		// Save messages after the target so we can restore them after regeneration
		const messagesAfter = fragment.messages.slice(idx + 1)
		fragment.messages = fragment.messages.slice(0, idx)

		// Refresh the workspace context on the last user message so that
		// any file switches since the original send are reflected in the retry.
		const lastUserIdx = fragment.messages.findLastIndex(
			(r) => r.message.role === 'user',
		)
		if (lastUserIdx !== -1) {
			const prevMessages = fragment.messages.slice(0, lastUserIdx)
			const current = captureWorkspaceContexts(this.plugin.app)
			const changed = computeChangedContexts(prevMessages, current)
			fragment.messages[lastUserIdx].workspaceContextDelta =
				changed.length > 0 ? changed : undefined
		}

		runtime.runState = 'thinking'
		await this.persistSession(session)
		this.notify()
		await this.startSessionProcessor(session.id)
		// Re-append the saved messages to achieve in-place replacement
		if (messagesAfter.length > 0) {
			const updatedFragment = this.getActiveFragment(session)
			updatedFragment.messages = [...updatedFragment.messages, ...messagesAfter]
			await this.persistSession(session)
			this.notify()
		}
	}

	private async stopSessionRun(session: AISession) {
		const runtime = this.getRuntime(session.id)
		if (
			runtime.runState !== 'thinking' &&
			runtime.runState !== 'waiting_for_tools' &&
			runtime.runState !== 'compressing'
		) {
			return
		}

		runtime.stopRequested = true

		const changed = this.cancelAllNonTerminalTasks(session, 'user_cancelled')

		if (changed) {
			void this.persistSession(session)
			this.notify()
			this.startQueuedTasksForSession(session)
		}

		await runtime.processing
	}

	private async loadSessionIndex() {
		const [metaRaw, indexRaw] = await Promise.all([
			chatMetaKV.get(CHAT_META_KEY),
			chatMetaKV.get(CHAT_INDEX_KEY),
		])
		const meta = this.isChatMetaRecord(metaRaw)
			? metaRaw
			: { orderedSessionIds: [] }
		const index = Array.isArray(indexRaw)
			? indexRaw.filter(
					(item): item is ChatSessionIndexItem =>
						!!item &&
						typeof item.id === 'string' &&
						typeof item.title === 'string' &&
						typeof item.createdAt === 'number' &&
						typeof item.updatedAt === 'number',
				)
			: []

		const indexById = new Map(index.map((item) => [item.id, item]))
		this.sessionIndex = meta.orderedSessionIds
			.map((sessionId) => indexById.get(sessionId))
			.filter((item): item is ChatSessionIndexItem => !!item)
		for (const item of index) {
			if (!meta.orderedSessionIds.includes(item.id)) {
				this.sessionIndex.push(item)
			}
		}
		this.activeSessionId = meta.activeSessionId
	}

	private async loadSessionById(sessionId: string) {
		const cached = this.loadedSessions.get(sessionId)
		if (cached) {
			return cached
		}

		const stored = await chatSessionKV.get(sessionId)
		if (!stored) {
			throw new Error(i18n.t('chatbox.errors.sessionNotFound'))
		}

		const { session, changed } = this.rehydrateSession(stored)
		this.loadedSessions.set(sessionId, session)
		const runtime = this.getRuntime(sessionId)
		runtime.pendingMessages = []
		this.upsertSessionIndexItem(session, deriveTitle(session))
		if (changed) {
			await this.persistSession(session)
			await this.persistMetaAndIndex()
		}
		return session
	}

	private async persistSession(session: AISession) {
		if (this.deletedSessionIds.has(session.id)) {
			return
		}
		await chatSessionKV.set(session.id, cloneSession(session))
	}

	private async persistMetaAndIndex() {
		const meta: ChatMetaRecord = {
			activeSessionId: this.activeSessionId,
			orderedSessionIds: this.sessionIndex.map((item) => item.id),
		}
		await Promise.all([
			chatMetaKV.set(CHAT_META_KEY, meta),
			chatMetaKV.set(
				CHAT_INDEX_KEY,
				this.sessionIndex.map((item) => ({ ...item })),
			),
		])
	}

	private rehydrateSession(session: AISession) {
		const rehydrated = this.normalizeSession(session)
		let changed = this.sanitizeSessionSelection(rehydrated)

		for (const task of rehydrated.tasks) {
			if (task.status !== 'queued' && task.status !== 'running') {
				continue
			}
			mutateTaskRecord(
				task,
				toCancelledTask(
					task,
					INTERRUPTED_TASK_CANCEL_REASON,
					Date.now(),
					i18n.t('chatbox.task.cancelledSummary', { task: task.title }),
				),
			)
			changed = true
		}

		return {
			session: rehydrated,
			changed,
		}
	}

	private normalizeSession(session: AISession): AISession {
		const normalized: AISession = {
			id: session.id,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt || session.createdAt,
			model: session.model ? { ...session.model } : undefined,
			systemPrompt: session.systemPrompt,
			inferenceParams: session.inferenceParams
				? { ...session.inferenceParams }
				: undefined,
			fragments:
				Array.isArray(session.fragments) && session.fragments.length > 0
					? session.fragments.map((fragment) => ({
							id: fragment.id,
							createdAt: fragment.createdAt,
							updatedAt: fragment.updatedAt || fragment.createdAt,
							summary: fragment.summary,
							messages: Array.isArray(fragment.messages)
								? fragment.messages.map((message) => ({
										...message,
										reversibleOps: Array.isArray(message.reversibleOps)
											? message.reversibleOps
													.filter(
														(op) =>
															!!op &&
															typeof op.vaultPath === 'string' &&
															(op.operation === 'create' ||
																op.operation === 'update' ||
																op.operation === 'delete') &&
															!!op.before &&
															(op.before.kind === 'file' ||
																op.before.kind === 'dir') &&
															(op.operation !== 'update' ||
																op.before.kind === 'file'),
													)
													.map(normalizeReversibleToolOpRecord)
													.filter(
														(
															op,
														): op is NonNullable<
															AIMessageRecord['reversibleOps']
														>[number] => !!op,
													)
											: undefined,
										message: cloneMessage(
											needsV0Migration(message.message)
												? migrateMessageFromV0(message.message)
												: message.message,
										),
										meta: message.meta
											? {
													...message.meta,
													usage: message.meta.usage
														? {
																...message.meta.usage,
															}
														: undefined,
												}
											: undefined,
									}))
								: [],
						}))
					: [
							{
								id: createId('fragment'),
								createdAt: Date.now(),
								updatedAt: Date.now(),
								messages: [],
							},
						],
			activeFragmentId: session.activeFragmentId,
			tasks: Array.isArray(session.tasks)
				? session.tasks.map((task) => ({ ...task }))
				: [],
		}

		if (
			!normalized.fragments.some(
				(item) => item.id === normalized.activeFragmentId,
			)
		) {
			normalized.activeFragmentId =
				normalized.fragments[normalized.fragments.length - 1].id
		}
		return normalized
	}

	private isChatMetaRecord(value: unknown): value is ChatMetaRecord {
		return (
			!!value &&
			typeof value === 'object' &&
			Array.isArray((value as ChatMetaRecord).orderedSessionIds)
		)
	}

	private upsertSessionIndexItem(
		session: AISession,
		title?: string,
		prepend = false,
	) {
		if (this.deletedSessionIds.has(session.id)) {
			return
		}
		const existingTitle =
			this.sessionIndex.find((e) => e.id === session.id)?.title ??
			i18n.t('chatbox.newChat')
		const item: ChatSessionIndexItem = {
			id: session.id,
			title: title ?? existingTitle,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
		}
		const existingIndex = this.sessionIndex.findIndex(
			(entry) => entry.id === session.id,
		)
		if (existingIndex === -1) {
			this.sessionIndex = prepend
				? [item, ...this.sessionIndex]
				: [...this.sessionIndex, item]
			return
		}

		const nextIndex = this.sessionIndex.slice()
		nextIndex[existingIndex] = item
		if (prepend && existingIndex > 0) {
			nextIndex.splice(existingIndex, 1)
			nextIndex.unshift(item)
		}
		this.sessionIndex = nextIndex
	}

	private buildTimeline(session: AISession): ChatboxProps['timeline'] {
		const timeline = session.fragments.flatMap((fragment) => {
			const items = projectFragmentMessageGroups(fragment.messages).map(
				({ record, blocks }) => ({
					id: `message:${record.id}`,
					kind: 'message' as const,
					createdAt: record.createdAt,
					message: cloneMessageRecord(record),
					displayBlocks: blocks,
					showHeader: true,
				}),
			)

			return [
				{
					id: `fragment:${fragment.id}`,
					kind: 'fragment' as const,
					createdAt: fragment.createdAt,
				},
				...items,
			]
		})

		let activeAgentModelId: string | undefined
		let previousAgentModelId: string | undefined
		let canContinueAgentGroup = false

		for (const item of timeline) {
			if (item.kind === 'fragment') {
				activeAgentModelId = undefined
				previousAgentModelId = undefined
				canContinueAgentGroup = false
				continue
			}

			const role = item.message.message.role
			if (role === 'user') {
				item.showHeader = true
				activeAgentModelId = undefined
				previousAgentModelId = undefined
				canContinueAgentGroup = false
				continue
			}

			if (role !== 'assistant' && role !== 'tool') {
				item.showHeader = true
				activeAgentModelId = undefined
				previousAgentModelId = undefined
				canContinueAgentGroup = false
				continue
			}

			const effectiveModelId =
				role === 'assistant' ? item.message.meta?.modelId : activeAgentModelId
			const showHeader =
				!canContinueAgentGroup ||
				!effectiveModelId ||
				effectiveModelId !== previousAgentModelId

			item.showHeader = showHeader
			activeAgentModelId =
				role === 'assistant' ? effectiveModelId : activeAgentModelId
			previousAgentModelId = effectiveModelId
			canContinueAgentGroup = !!effectiveModelId
		}

		return timeline
	}

	private collectOtherSessionTasks() {
		return Array.from(this.loadedSessions.values())
			.filter((session) => session.id !== this.activeSessionId)
			.flatMap((session) => session.tasks)
			.sort((left, right) => right.createdAt - left.createdAt)
	}

	private collectOtherBusySessionIds() {
		return Array.from(this.loadedSessions.values())
			.filter((session) => session.id !== this.activeSessionId)
			.filter((session) => {
				const runtime = this.getRuntime(session.id)
				return (
					runtime.runState !== 'idle' ||
					!!runtime.processing ||
					runtime.pendingMessages.length > 0
				)
			})
			.map((session) => session.id)
	}

	private getLoadedActiveSession() {
		return this.activeSessionId
			? this.loadedSessions.get(this.activeSessionId)
			: undefined
	}

	private async startSessionProcessor(sessionId: string) {
		const runtime = this.getRuntime(sessionId)
		if (runtime.processing) {
			return runtime.processing
		}

		runtime.processing = this.runSessionProcessor(sessionId).finally(() => {
			const latestRuntime = this.getRuntime(sessionId)
			latestRuntime.processing = undefined
			if (
				latestRuntime.runState === 'idle' &&
				(latestRuntime.pendingMessages.length ||
					latestRuntime.pendingUserContext.length)
			) {
				void this.startSessionProcessor(sessionId)
				return
			}
			if (latestRuntime.runState === 'idle') {
				this.notify()
			}
		})
		return runtime.processing
	}

	private async runSessionProcessor(sessionId: string) {
		const runtime = this.getRuntime(sessionId)
		const session = this.loadedSessions.get(sessionId)
		if (!session) {
			runtime.runState = 'idle'
			return
		}

		try {
			const provider = this.getProviderOrThrow(session)
			const model = this.getModelOrThrow(provider, session)
			let repeatState: ToolCallRepeatState = {
				consecutiveCount: 0,
				isRepeatedTooManyTimes: false,
			}

			while (true) {
				const fragment = this.getActiveFragment(session)
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

				const tools = this.createToolsForContext(session, 0, MAX_TASK_DEPTH)
				await this.plugin.nutstoreLlmGatewayService.ensureProviderReady(
					provider,
				)
				const requestMessages = this.buildMessagesForFragment(fragment, session)
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
					assistantRecord = this.createMessageRecord(
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
								this.deletedSessionIds.has(session.id) ||
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

				if (this.deletedSessionIds.has(session.id)) {
					runtime.stopRequested = false
					runtime.runState = 'idle'
					return
				}

				if (runtime.stopRequested) {
					const record = ensureAssistantRecord()
					record.message = response.message
					record.meta = { ...response.meta, modelId: model.id }
					this.finishStoppedSessionRun(session, fragment)
					await this.persistSession(session)
					return
				}

				const record = ensureAssistantRecord()
				record.message = response.message
				record.meta = { ...response.meta, modelId: model.id }
				fragment.updatedAt = Date.now()
				session.updatedAt = Date.now()
				await this.persistSession(session)
				this.notify()

				const assistantToolCalls = getAssistantToolCalls(response.message)
				if (!assistantToolCalls?.length) {
					runtime.runState = 'idle'
					continue
				}

				repeatState = updateToolCallRepeatState(repeatState, assistantToolCalls)
				if (repeatState.isRepeatedTooManyTimes) {
					this.reportFatalError(
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
					await this.persistSession(session)
					return
				}

				runtime.runState = 'waiting_for_tools'
				this.notify()

				const toolMessages = await this.resolveToolCalls(
					assistantToolCalls,
					tools,
					{
						session,
						depth: 0,
						maxDepth: MAX_TASK_DEPTH,
					},
				)

				if (runtime.stopRequested) {
					this.finishStoppedSessionRun(session, fragment)
					await this.persistSession(session)
					return
				}

				for (const item of toolMessages) {
					fragment.messages.push(
						this.createMessageRecord(item.message, {
							isError: item.isError,
							reversibleOps: item.reversibleOps,
						}),
					)
				}
				await this.persistSession(session)
				this.notify()
			}
		} catch (error) {
			if (this.deletedSessionIds.has(session.id)) {
				runtime.runState = 'idle'
				return
			}
			const activeFragment = this.getActiveFragment(session)
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
			this.reportFatalError(
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
			await this.persistSession(session)
		}
	}

	private async flushPendingMessages(session: AISession) {
		const runtime = this.getRuntime(session.id)
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
			await this.prepareUserContextForMessage(pendingUserContext)
		if (!mergedText && preparedContext.dedupedItems.length === 0) {
			this.notify()
			return false
		}

		const fragment = this.getActiveFragment(session)
		this.appendUserMessage(
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
		this.upsertSessionIndexItem(session, deriveTitle(session))
		void this.persistSession(session)
		void this.persistMetaAndIndex()
		this.notify()
		return true
	}

	private getRuntime(sessionId: string): SessionRuntimeState {
		let runtime = this.runtimeBySessionId.get(sessionId)
		if (!runtime) {
			runtime = {
				runState: 'idle',
				pendingMessages: [],
				pendingUserContext: [],
				pendingInputDraft: '',
			}
			this.runtimeBySessionId.set(sessionId, runtime)
		}
		return runtime
	}

	private getAutoApproveRequests(sessionId: string) {
		let requests = this.autoApproveRequestsBySessionId.get(sessionId)
		if (!requests) {
			requests = new Set<string>()
			this.autoApproveRequestsBySessionId.set(sessionId, requests)
		}
		return requests
	}

	private createPendingMessage(text: string): ChatPendingMessage {
		return {
			id: createId('pending'),
			createdAt: Date.now(),
			text,
		}
	}

	private createFragment(session: AISession): ChatFragment {
		const now = Date.now()
		const fragment: ChatFragment = {
			id: createId('fragment'),
			createdAt: now,
			updatedAt: now,
			messages: [],
		}
		session.fragments = [...session.fragments, fragment]
		session.activeFragmentId = fragment.id
		return fragment
	}

	private getActiveFragment(session: AISession) {
		return (
			session.fragments.find((item) => item.id === session.activeFragmentId) ||
			session.fragments[session.fragments.length - 1]
		)
	}

	private appendUserMessage(
		fragment: ChatFragment,
		text: string,
		session?: AISession,
		userContext?: UserContextItem[],
		imageParts?: Extract<AIMessageContentPart, { type: 'image' }>[],
	) {
		const now = Date.now()
		fragment.updatedAt = now
		if (session) {
			session.updatedAt = now
		}
		const current = captureWorkspaceContexts(this.plugin.app)
		const changed = computeChangedContexts(fragment.messages, current)
		const content: (TextPart | ImagePart)[] = []
		if (imageParts?.length) {
			content.push(...imageParts)
		}
		if (text) {
			content.push(...toTextParts(text))
		}
		const record = this.createMessageRecord({
			role: 'user',
			content,
		})
		if (changed.length > 0) {
			record.workspaceContextDelta = changed
		}
		if (userContext && userContext.length > 0) {
			record.userContext = cloneUserContextItems(userContext)
		}
		fragment.messages.push(record)
	}

	private finishStoppedSessionRun(session: AISession, fragment: ChatFragment) {
		const runtime = this.getRuntime(session.id)
		this.removeUnmatchedToolCalls(fragment)
		runtime.stopRequested = false
		runtime.runState = 'idle'
		this.notify()
	}

	private cancelAllNonTerminalTasks(session: AISession, cancelReason: string) {
		let changed = false
		for (const task of session.tasks) {
			if (this.isTaskTerminal(task)) {
				continue
			}
			mutateTaskRecord(
				task,
				toCancelledTask(
					task,
					cancelReason,
					Date.now(),
					i18n.t('chatbox.task.cancelledSummary', { task: task.title }),
				),
			)
			this.resolveTaskCompletion(task.id, this.buildTaskToolPayload(task))
			this.cleanupTaskTracking(task.id)
			changed = true
		}
		return changed
	}

	private cleanupSessionTaskTracking(session: AISession) {
		for (const task of session.tasks) {
			this.cleanupTaskTracking(task.id)
		}
	}

	private async runTask(task: AITaskRecord) {
		const session = this.loadedSessions.get(task.sessionId)
		const selection = this.taskModelSelection.get(task.id)
		if (!session || !selection?.providerId || !selection.modelId) {
			this.finishTaskAsFailed(
				task,
				i18n.t('chatbox.errors.taskSessionUnavailable'),
				'session_invalid',
			)
			return
		}

		try {
			const provider = this.getProviderByIdOrThrow(selection.providerId)
			await this.plugin.nutstoreLlmGatewayService.ensureProviderReady(provider)
			const model = this.getModelByIdsOrThrow(provider, selection.modelId)
			const result = await this.runBackgroundTaskLoop(
				task,
				session,
				provider,
				model,
			)

			if (task.status === 'cancelled') {
				return
			}

			if (result.status === 'completed') {
				this.finishTaskAsCompleted(
					task,
					result.summary || '',
					result.sourceCount,
				)
				return
			}
			if (result.status === 'cancelled') {
				this.finishTaskAsCancelled(task, 'user_cancelled')
				return
			}
			this.finishTaskAsFailed(
				task,
				result.error || i18n.t('chatbox.requestFailed'),
				result.failureStage,
				result.sourceCount,
			)
		} catch (error) {
			if (task.status === 'cancelled') {
				return
			}
			logger.error(error)
			this.finishTaskAsFailed(
				task,
				extractErrorMessage(error, i18n.t('chatbox.requestFailed')),
				'runtime_error',
			)
		}
	}

	private async runBackgroundTaskLoop(
		task: AITaskRecord,
		session: AISession,
		provider: AIProviderConfig,
		model: { id: string },
	): Promise<AgentRunResult> {
		const tools = this.createToolsForContext(
			session,
			task.depth,
			task.maxDepth,
			task.id,
		)
		const messages: AIMessage[] = [
			{
				role: 'system',
				content: createSubagentSystemPrompt(task.depth < task.maxDepth),
			},
			{
				role: 'user',
				content: toTextParts(task.prompt),
			},
		]
		let sourceCount = 0
		let repeatState: ToolCallRepeatState = {
			consecutiveCount: 0,
			isRepeatedTooManyTimes: false,
		}

		while (true) {
			if (task.status === 'cancelled') {
				return {
					status: 'cancelled',
					sourceCount,
				}
			}

			await this.plugin.nutstoreLlmGatewayService.ensureProviderReady(provider)
			const response = await generateAssistantTurn({
				provider,
				model: model.id,
				messages,
				tools,
				...session.inferenceParams,
			})
			messages.push(response.message)

			const assistantToolCalls = getAssistantToolCalls(response.message)
			if (!assistantToolCalls?.length) {
				return {
					status: 'completed',
					summary:
						messageToText(response.message).trim() ||
						i18n.t('chatbox.task.emptyResult'),
					sourceCount,
				}
			}

			repeatState = updateToolCallRepeatState(repeatState, assistantToolCalls)
			if (repeatState.isRepeatedTooManyTimes) {
				return {
					status: 'failed',
					error: i18n.t('chatbox.repeatedToolCallsStopped', {
						count: REPEATED_TOOL_CALL_THRESHOLD,
					}),
					failureStage: 'repeated_tool_calls',
					sourceCount,
				}
			}

			const toolMessages = await this.resolveToolCalls(
				assistantToolCalls,
				tools,
				{
					session,
					depth: task.depth,
					maxDepth: task.maxDepth,
					parentTaskId: task.id,
				},
			)

			for (const item of toolMessages) {
				messages.push(item.message)
				sourceCount += 1
			}
		}
	}

	private async resolveToolCalls(
		toolCalls: AIToolCall[],
		tools: AIToolDefinition[],
		context: AIToolExecutionContext,
	) {
		const toolsByName = new Map(tools.map((t) => [t.name, t]))
		const results = await Promise.all(
			toolCalls.map((toolCall) =>
				this.resolveSingleToolCall(toolCall, toolsByName, context),
			),
		)

		return toolCalls.map((toolCall, index) => ({
			message: {
				role: 'tool' as const,
				content: [
					{
						type: 'tool-result' as const,
						toolCallId: toolCall.toolCallId,
						toolName: toolCall.toolName,
						output: {
							type: 'text' as const,
							value:
								typeof results[index].payload === 'string'
									? results[index].payload
									: JSON.stringify(results[index].payload, null, 2),
						},
					},
				],
			},
			isError: results[index].isError,
			reversibleOps: results[index].reversibleOps,
		}))
	}

	private async resolveSingleToolCall(
		toolCall: AIToolCall,
		toolsByName: Map<string, AIToolDefinition>,
		context: AIToolExecutionContext,
	): Promise<ResolvedToolResult> {
		const inputJson = JSON.stringify(toolCall.input ?? {})
		if (toolCall.toolName === 'spawn') {
			const payload = await this.startSpawnedTask(inputJson, context)
			return {
				payload,
				isError: payload.status !== 'completed',
			}
		}

		const result = await this.executeToolCall(
			toolsByName,
			toolCall.toolName,
			inputJson,
			context,
		)
		return {
			payload: result.payload,
			reversibleOps: result.reversibleOps,
			isError: typeof result.payload === 'object' && !!result.payload.error,
		}
	}

	private startSpawnedTask(
		rawArgs: string,
		context: AIToolExecutionContext,
	): Promise<Record<string, unknown>> {
		try {
			const params = JSON.parse(rawArgs) as Record<string, unknown>
			const promptText = this.requireToolString(params.task, 'task')
			const title =
				typeof params.label === 'string' && params.label.trim()
					? params.label.trim()
					: undefined
			return this.spawnTask({
				prompt: promptText,
				title,
				parentTaskId: context.parentTaskId,
				depth: context.depth + 1,
				maxDepth: context.maxDepth,
				sessionId: context.session.id,
			})
		} catch (error) {
			return Promise.resolve({
				task_id: null,
				parent_task_id: context.parentTaskId ?? null,
				label: null,
				task: null,
				status: 'failed',
				result_summary: null,
				error_summary: error instanceof Error ? error.message : String(error),
				failure_stage: 'invalid_arguments',
				cancel_reason: null,
				depth: context.depth + 1,
				max_depth: context.maxDepth,
				started_at: null,
				finished_at: Date.now(),
				source_count: null,
			})
		}
	}

	private spawnTask(params: {
		prompt: string
		title?: string
		parentTaskId?: string
		depth: number
		maxDepth: number
		sessionId: string
	}) {
		const session = this.loadedSessions.get(params.sessionId)
		if (!session) {
			return Promise.resolve(
				this.buildImmediateTaskFailurePayload(
					params,
					i18n.t('chatbox.errors.sessionNotFound'),
					'session_invalid',
				),
			)
		}
		if (params.depth > params.maxDepth) {
			return Promise.resolve(
				this.buildImmediateTaskFailurePayload(
					params,
					i18n.t('chatbox.errors.taskDepthExceeded'),
					'depth_limit',
				),
			)
		}

		const shouldQueue =
			this.countRunningTasksForSession(session) >=
			MAX_CONCURRENT_TASKS_PER_SESSION

		const taskId = createId('task')
		const taskBase = {
			id: taskId,
			sessionId: session.id,
			parentTaskId: params.parentTaskId,
			depth: params.depth,
			maxDepth: params.maxDepth,
			title: params.title || params.prompt.slice(0, 48),
			prompt: params.prompt,
			createdAt: Date.now(),
		}
		const task: AITaskRecord = shouldQueue
			? createQueuedTask(taskBase)
			: createRunningTask(taskBase, Date.now())
		const deferred = this.createDeferredTaskCompletion()

		session.tasks = [task, ...session.tasks]
		this.taskModelSelection.set(task.id, session.model)
		this.pendingTaskCompletions.set(task.id, deferred)
		void this.persistSession(session)
		this.notify()

		if (shouldQueue) {
			this.startQueuedTasksForSession(session)
		} else {
			void this.runTask(task)
		}

		return deferred.promise
	}

	private afterTaskSettled(task: AITaskRecord) {
		const session = this.loadedSessions.get(task.sessionId)
		if (session) void this.persistSession(session)
		this.notify()
		this.resolveTaskCompletion(task.id, this.buildTaskToolPayload(task))
		this.cleanupTaskTracking(task.id)
		if (session) this.startQueuedTasksForSession(session)
	}

	private finishTaskAsCompleted(
		task: AITaskRecord,
		summary: string,
		sourceCount: number,
	) {
		if (task.status !== 'running') return
		mutateTaskRecord(
			task,
			toCompletedTask(
				task,
				summary || i18n.t('chatbox.task.emptyResult'),
				sourceCount,
				Date.now(),
			),
		)
		this.afterTaskSettled(task)
	}

	private finishTaskAsFailed(
		task: AITaskRecord,
		message: string,
		failureStage?: string,
		sourceCount?: number,
	) {
		if (task.status !== 'queued' && task.status !== 'running') return
		mutateTaskRecord(
			task,
			toFailedTask(task, message, Date.now(), failureStage, sourceCount),
		)
		this.afterTaskSettled(task)
	}

	private finishTaskAsCancelled(task: AITaskRecord, cancelReason: string) {
		if (task.status === 'queued' || task.status === 'running') {
			mutateTaskRecord(
				task,
				toCancelledTask(
					task,
					cancelReason,
					Date.now(),
					i18n.t('chatbox.task.cancelledSummary', { task: task.title }),
				),
			)
		}
		this.afterTaskSettled(task)
	}

	private countRunningTasksForSession(session: AISession) {
		return session.tasks.filter((item) => item.status === 'running').length
	}

	private startQueuedTasksForSession(session: AISession) {
		if (this.deletedSessionIds.has(session.id)) {
			return
		}
		while (
			this.countRunningTasksForSession(session) <
			MAX_CONCURRENT_TASKS_PER_SESSION
		) {
			const nextTask = session.tasks
				.filter((item) => item.status === 'queued')
				.sort((left, right) => left.createdAt - right.createdAt)[0]

			if (!nextTask) {
				return
			}

			mutateTaskRecord(
				nextTask,
				toRunningTask(nextTask as QueuedChatTask, Date.now()),
			)
			void this.persistSession(session)
			this.notify()
			void this.runTask(nextTask)
		}
	}

	private createToolsForContext(
		session: AISession,
		depth: number,
		maxDepth: number,
		parentTaskId?: string,
	) {
		const allowSpawn = depth < maxDepth
		const permissionGuard = createPermissionGuard(
			this.plugin.app,
			() => this.plugin.settings,
			{
				has: (signature) =>
					this.getAutoApproveRequests(session.id).has(signature),
				add: (signature) => {
					this.getAutoApproveRequests(session.id).add(signature)
				},
			},
			{
				sessionTitle:
					this.sessionIndex.find((item) => item.id === session.id)?.title ||
					deriveTitle(session),
				modalMountTarget: this.getChatModalMountTarget(),
			},
		)
		return createAITools(this.plugin.app, {
			allowSpawn,
			permissionGuard,
			spawnTask: async (params) => ({
				task_id: null,
				parent_task_id: parentTaskId || params.parentTaskId || null,
				label: params.title || params.prompt.slice(0, 48),
				task: params.prompt,
				status: 'running',
				depth: params.depth,
				max_depth: params.maxDepth,
				async: true,
			}),
		})
	}

	private getChatModalMountTarget() {
		return resolveChatModalMountTarget(this.chatModalHostEl)
	}

	private async executeToolCall(
		toolsByName: Map<string, AIToolDefinition>,
		name: string,
		args: string,
		context: AIToolExecutionContext,
	) {
		const tool = toolsByName.get(name)
		let result: ToolExecutionResult

		try {
			if (!tool) {
				throw new Error(
					i18n.t('chatbox.errors.unknownTool', {
						name,
					}),
				)
			}
			const parsedArgs = JSON.parse(args) as Record<string, unknown>
			const params = tool.inputSchema.parse(parsedArgs)
			result = await tool.execute(params, context)
		} catch (error) {
			logger.error(error)
			result = {
				result: {
					error: error instanceof Error ? error.message : String(error),
				},
			}
		}

		return {
			payload: result.result,
			reversibleOps: result.reversibleOps
				?.map(normalizeReversibleToolOpRecord)
				.filter(
					(op): op is NonNullable<AIMessageRecord['reversibleOps']>[number] =>
						!!op,
				),
		}
	}

	private dedupeUserContextItems(items: UserContextItem[]): UserContextItem[] {
		const deduped: UserContextItem[] = []
		const seen = new Set<string>()
		for (const item of items) {
			const hash = getUserContextItemHash(item)
			if (seen.has(hash)) {
				continue
			}
			seen.add(hash)
			deduped.push(cloneUserContextItem(item))
		}
		return deduped
	}

	private async prepareUserContextForMessage(items: UserContextItem[]) {
		const dedupedItems: UserContextItem[] = []
		const imageParts: Extract<AIMessageContentPart, { type: 'image' }>[] = []
		const seen = new Set<string>()
		for (const item of items) {
			const hash = getUserContextItemHash(item)
			if (seen.has(hash)) {
				continue
			}
			seen.add(hash)
			if (item.type === 'image') {
				const imageBlob =
					item.blob.type === item.mimeType
						? item.blob
						: new Blob([item.blob], {
								type: item.mimeType,
							})
				const imageUrl = await blobToDataUrl(imageBlob)
				dedupedItems.push(cloneUserContextItem(item))
				imageParts.push({
					type: 'image',
					image: imageUrl,
				})
				continue
			}
			dedupedItems.push(cloneUserContextItem(item))
		}
		return {
			dedupedItems,
			imageParts,
		}
	}

	private buildMessagesForFragment(
		fragment: ChatFragment,
		session: AISession,
	): AIMessage[] {
		return [
			{
				role: 'system',
				content: session.systemPrompt || createMainSystemPrompt(MAX_TASK_DEPTH),
			},
			...fragment.messages.map((item) => {
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
					? this.dedupeUserContextItems(item.userContext)
					: []
				const textContext = dedupedContext.filter(
					(contextItem) => contextItem.type !== 'image',
				)
				if (textContext.length) {
					prefixParts.push({
						type: 'text',
						text: formatUserContext(textContext),
					})
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
		]
	}

	private async restoreFilesForRecall(
		operations: NonNullable<AIMessageRecord['reversibleOps']>,
	) {
		const normalizedOperations = operations
			.map(normalizeReversibleToolOpRecord)
			.filter(
				(op): op is NonNullable<AIMessageRecord['reversibleOps']>[number] =>
					!!op,
			)
		if (normalizedOperations.length === 0) {
			return
		}

		const earliestByPath = new Map<
			string,
			(typeof normalizedOperations)[number]
		>()
		for (const operation of normalizedOperations) {
			if (!earliestByPath.has(operation.vaultPath)) {
				earliestByPath.set(operation.vaultPath, operation)
			}
		}

		const deletePaths = new Set<string>()
		const restoreDirs = new Set<string>()
		const restoreFiles = new Map<
			string,
			Extract<
				NonNullable<AIMessageRecord['reversibleOps']>[number],
				{ operation: 'update' }
			>['before']
		>()

		for (const operation of earliestByPath.values()) {
			if (operation.operation === 'create') {
				deletePaths.add(operation.vaultPath)
				continue
			}
			if (operation.operation === 'update') {
				restoreFiles.set(operation.vaultPath, operation.before)
				continue
			}
			if (operation.before.kind === 'dir') {
				restoreDirs.add(operation.vaultPath)
				continue
			}
			restoreFiles.set(operation.vaultPath, operation.before)
		}

		logger.info(
			`Recall restore start: ${normalizedOperations.length} recorded ops, ` +
				`${deletePaths.size} deletes, ${restoreDirs.size} directories, ${restoreFiles.size} files.`,
		)

		for (const path of [...deletePaths].sort((left, right) => {
			const depthDelta = getPathDepth(right) - getPathDepth(left)
			return depthDelta !== 0 ? depthDelta : left.localeCompare(right)
		})) {
			await this.deleteVaultPathIfExists(path)
		}

		const requiredDirs = new Set<string>(restoreDirs)
		for (const filePath of restoreFiles.keys()) {
			for (const parentPath of getParentVaultPaths(filePath)) {
				requiredDirs.add(parentPath)
			}
		}

		for (const path of [...requiredDirs].sort((left, right) => {
			const depthDelta = getPathDepth(left) - getPathDepth(right)
			return depthDelta !== 0 ? depthDelta : left.localeCompare(right)
		})) {
			await this.ensureVaultDirectory(path)
		}

		for (const filePath of [...restoreFiles.keys()].sort((left, right) => {
			const depthDelta = getPathDepth(left) - getPathDepth(right)
			return depthDelta !== 0 ? depthDelta : left.localeCompare(right)
		})) {
			const snapshot = restoreFiles.get(filePath)
			if (snapshot) {
				await this.writeVaultFile(filePath, snapshot)
			}
		}

		logger.info('Recall restore completed.')
	}

	private async deleteVaultPathIfExists(path: string) {
		const target = this.plugin.app.vault.getAbstractFileByPath(path)
		if (!target) {
			return
		}
		if (isVaultFolder(target) && target.children.length > 0) {
			logger.info(`Recall restore skip non-empty dir: ${path}`)
			return
		}
		logger.info(`Recall restore delete: ${path}`)
		if (typeof this.plugin.app.vault.delete === 'function') {
			await this.plugin.app.vault.delete(target, true)
			return
		}
		if (typeof this.plugin.app.vault.trash === 'function') {
			await this.plugin.app.vault.trash(target, false)
			return
		}
		throw new Error(`Unable to delete ${path}: vault delete is unavailable.`)
	}

	private async ensureVaultDirectory(path: string) {
		if (!path) {
			return
		}
		const target = this.plugin.app.vault.getAbstractFileByPath(path)
		if (target) {
			if (isVaultFolder(target)) {
				return
			}
			throw new Error(`Unable to restore ${path}: a file already exists there.`)
		}
		logger.info(`Recall restore mkdir: ${path}`)
		await this.plugin.app.vault.createFolder(path)
	}

	private async writeVaultFile(
		path: string,
		content: Extract<
			NonNullable<AIMessageRecord['reversibleOps']>[number],
			{ operation: 'update' }
		>['before'],
	) {
		const data = await decodeReversibleFileSnapshot(content)
		const existing = this.plugin.app.vault.getAbstractFileByPath(path)
		if (existing && isVaultFolder(existing)) {
			throw new Error(
				`Unable to restore ${path}: a directory already exists there.`,
			)
		}
		if (existing && isVaultFile(existing)) {
			logger.info(`Recall restore write: ${path} (overwrite)`)
			await this.plugin.app.vault.modifyBinary(existing as never, data)
			return
		}
		logger.info(`Recall restore write: ${path} (create)`)
		await this.plugin.app.vault.createBinary(path, data)
	}

	private removeUnmatchedToolCalls(fragment: ChatFragment) {
		const resolvedToolCallIds = new Set(
			fragment.messages.flatMap((item) => {
				if (
					item.message.role !== 'tool' ||
					!Array.isArray(item.message.content)
				) {
					return []
				}
				const part = (
					item.message.content as Array<{ type: string; toolCallId?: string }>
				)[0]
				return part?.type === 'tool-result' && part.toolCallId
					? [part.toolCallId]
					: []
			}),
		)

		fragment.messages = fragment.messages.filter((record) => {
			if (
				record.message.role !== 'assistant' ||
				!Array.isArray(record.message.content)
			) {
				return true
			}
			const content = record.message.content as Array<
				{ type: string } & Partial<ToolCallPart>
			>
			const toolCalls = content.filter(
				(p): p is ToolCallPart => p.type === 'tool-call',
			)
			if (toolCalls.length === 0) {
				return true
			}

			const nextToolCalls = toolCalls.filter((tc) =>
				resolvedToolCallIds.has(tc.toolCallId),
			)
			const nonToolParts = content.filter((p) => p.type !== 'tool-call')
			const hasText = !!messageToText(record.message).trim()
			if (!hasText && nextToolCalls.length === 0) {
				return false
			}

			record.message = {
				...record.message,
				content: [...nonToolParts, ...nextToolCalls],
			} as AssistantModelMessage
			return true
		})
	}

	private buildTaskToolPayload(task: AITaskRecord) {
		return {
			task_id: task.id,
			parent_task_id: task.parentTaskId ?? null,
			label: task.title,
			task: task.prompt,
			status: task.status,
			result_summary:
				task.status === 'completed' ? (task.summary ?? null) : null,
			error_summary:
				task.status === 'failed' ? task.error || task.summary || null : null,
			failure_stage:
				task.status === 'failed' ? (task.failureStage ?? null) : null,
			cancel_reason:
				task.status === 'cancelled' ? (task.cancelReason ?? null) : null,
			depth: task.depth,
			max_depth: task.maxDepth,
			started_at: 'startedAt' in task ? (task.startedAt ?? null) : null,
			finished_at: 'finishedAt' in task ? (task.finishedAt ?? null) : null,
			source_count:
				task.status === 'completed'
					? task.sourceCount
					: task.status === 'failed'
						? (task.sourceCount ?? null)
						: null,
		}
	}

	private buildImmediateTaskFailurePayload(
		params: {
			prompt: string
			title?: string
			parentTaskId?: string
			depth: number
			maxDepth: number
		},
		message: string,
		failureStage: string,
	) {
		return {
			task_id: null,
			parent_task_id: params.parentTaskId ?? null,
			label: params.title || params.prompt.slice(0, 48),
			task: params.prompt,
			status: 'failed',
			result_summary: null,
			error_summary: message,
			failure_stage: failureStage,
			cancel_reason: null,
			depth: params.depth,
			max_depth: params.maxDepth,
			started_at: null,
			finished_at: Date.now(),
			source_count: null,
		}
	}

	private createDeferredTaskCompletion(): DeferredTaskCompletion {
		let resolve!: (payload: Record<string, unknown>) => void
		const deferred: DeferredTaskCompletion = {
			promise: new Promise<Record<string, unknown>>((nextResolve) => {
				resolve = nextResolve
			}),
			resolve: (payload) => {
				deferred.settled = true
				resolve(payload)
			},
			settled: false,
		}
		return deferred
	}

	private resolveTaskCompletion(
		taskId: string,
		payload: Record<string, unknown>,
	) {
		const deferred = this.pendingTaskCompletions.get(taskId)
		if (!deferred || deferred.settled) {
			return
		}
		deferred.resolve(payload)
		this.pendingTaskCompletions.delete(taskId)
	}

	private cleanupTaskTracking(taskId: string) {
		this.pendingTaskCompletions.delete(taskId)
		this.taskModelSelection.delete(taskId)
	}

	private requireToolString(value: unknown, field: string) {
		if (typeof value !== 'string' || !value.trim()) {
			throw new Error(i18n.t('chatbox.errors.toolFieldRequired', { field }))
		}
		return value.trim()
	}

	private isTaskTerminal(task: AITaskRecord) {
		return isTerminalTask(task)
	}

	private isTaskDescendantOf(
		session: AISession,
		task: AITaskRecord,
		ancestorTaskId: string,
	): boolean {
		let currentParentId = task.parentTaskId
		while (currentParentId) {
			if (currentParentId === ancestorTaskId) {
				return true
			}
			currentParentId = session.tasks.find(
				(item) => item.id === currentParentId,
			)?.parentTaskId
		}
		return false
	}

	private requireProvider(id: string | undefined): AIProviderConfig {
		const provider = getProviderById(this.plugin.settings.ai.providers, id)
		if (!provider) throw new Error(i18n.t('chatbox.errors.noProvider'))
		assertProviderUsable(provider)
		return provider
	}

	private requireModel(provider: AIProviderConfig, id: string | undefined) {
		const model = getModelById(provider, id)
		if (!model) throw new Error(i18n.t('chatbox.errors.noModel'))
		return model
	}

	private getProviderOrThrow(session: AISession) {
		return this.requireProvider(session.model?.providerId)
	}
	private getProviderByIdOrThrow(id: string) {
		return this.requireProvider(id)
	}
	private getModelOrThrow(provider: AIProviderConfig, session: AISession) {
		return this.requireModel(provider, session.model?.modelId)
	}
	private getModelByIdsOrThrow(provider: AIProviderConfig, id: string) {
		return this.requireModel(provider, id)
	}

	private createEmptySession(): AISession {
		const { providerId, modelId } = this.getInitialSelectionForNewSession()
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

	private createMessageRecord(
		message: AIMessage,
		options?: {
			meta?: AIMessageRecord['meta']
			isError?: boolean
			reversibleOps?: AIMessageRecord['reversibleOps']
		},
	): AIMessageRecord {
		return {
			id: createId('message'),
			createdAt: Date.now(),
			message,
			meta: options?.meta,
			isError: options?.isError,
			reversibleOps: options?.reversibleOps
				?.map(normalizeReversibleToolOpRecord)
				.filter(
					(op): op is NonNullable<AIMessageRecord['reversibleOps']>[number] =>
						!!op,
				),
		}
	}

	private sanitizeSessionSelection(session: AISession) {
		if (!session.model) {
			if (this.sessionHasMessages(session)) {
				return false
			}

			const fallbackSelection = resolveInitialSelection(
				this.plugin.settings.ai.providers,
				this.plugin.settings.ai.defaultModel,
			)
			const fallbackProvider = getProviderById(
				this.plugin.settings.ai.providers,
				fallbackSelection.providerId,
			)
			const fallbackModel = getModelById(
				fallbackProvider,
				fallbackSelection.modelId,
			)
			if (!fallbackProvider || !fallbackModel) {
				return false
			}

			session.model = {
				providerId: fallbackProvider.id,
				modelId: fallbackModel.id,
			}
			return true
		}

		const provider = getProviderById(
			this.plugin.settings.ai.providers,
			session.model?.providerId,
		)
		if (!provider) {
			session.model = undefined
			return true
		}

		const nextModelId =
			getModelById(provider, session.model?.modelId)?.id ||
			getFirstModel(provider)?.id
		const nextModel = nextModelId
			? { providerId: provider.id, modelId: nextModelId }
			: undefined
		const changed =
			session.model?.providerId !== provider.id ||
			session.model?.modelId !== nextModelId
		session.model = nextModel
		return changed
	}

	private sessionHasMessages(session: AISession) {
		return session.fragments.some((fragment) => fragment.messages.length > 0)
	}

	private getInitialSelectionForNewSession() {
		const emptyStateSelection = this.getEmptyStateSelection()
		return {
			providerId: emptyStateSelection.providerId,
			modelId: emptyStateSelection.modelId,
		}
	}

	private getEmptyStateSelection() {
		const defaults = resolveInitialSelection(
			this.plugin.settings.ai.providers,
			this.plugin.settings.ai.defaultModel,
		)
		const provider =
			getProviderById(
				this.plugin.settings.ai.providers,
				this.pendingProviderId,
			) ||
			getProviderById(this.plugin.settings.ai.providers, defaults.providerId)
		const model =
			getModelById(provider, this.pendingModelId) ||
			getModelById(provider, defaults.modelId) ||
			getFirstModel(provider)

		return {
			providerId: provider?.id,
			modelId: model?.id,
		}
	}

	private syncPendingSelectionWithSettings() {
		const defaults = resolveInitialSelection(
			this.plugin.settings.ai.providers,
			this.plugin.settings.ai.defaultModel,
		)
		const provider = getProviderById(
			this.plugin.settings.ai.providers,
			defaults.providerId,
		)
		const model =
			getModelById(provider, defaults.modelId) || getFirstModel(provider)
		this.pendingProviderId = provider?.id
		this.pendingModelId = model?.id
	}

	private findLoadedSessionByTaskId(taskId: string) {
		for (const session of this.loadedSessions.values()) {
			if (session.tasks.some((task) => task.id === taskId)) {
				return session
			}
		}
		return undefined
	}

	private notify() {
		for (const listener of this.listeners) {
			listener()
		}
	}

	private validateSessionSelection(session: AISession) {
		try {
			const provider = this.getProviderOrThrow(session)
			this.getModelOrThrow(provider, session)
			return true
		} catch (error) {
			const message =
				error instanceof Error ? error.message : i18n.t('chatbox.requestFailed')
			logger.error(error)
			new Notice(message)
			return false
		}
	}

	private reportFatalError(
		session: AISession,
		message: string,
		meta?: AIMessageRecord['meta'],
		fragment: ChatFragment = this.getActiveFragment(session),
	) {
		logger.error(message)
		fragment.messages.push(
			this.createMessageRecord(
				{
					role: 'assistant',
					content: toTextParts(message),
				},
				{ meta, isError: true },
			),
		)
		this.notify()
	}
}
