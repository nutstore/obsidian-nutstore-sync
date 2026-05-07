import { Notice, normalizePath } from 'obsidian'
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
import {
	ChatFragment,
	ChatMessage,
	ChatPendingMessage,
	ChatRunState,
	ChatSessionIndexItem,
	cloneMessage,
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
import type { ChatboxProps, ChatProviderOption } from '~/chatbox/types'
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
const INTERRUPTED_TASK_FAILURE_STAGE = 'interrupted_by_restart'
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
}

function toTextParts(text: string): AIMessageContentPart[] {
	return [{ type: 'text', text }]
}

function messageToText(message: Pick<ChatMessage, 'content'> | AIMessage) {
	if (!message.content) {
		return ''
	}
	return message.content
		.filter(
			(part): part is Extract<AIMessageContentPart, { type: 'text' }> =>
				part.type === 'text',
		)
		.map((part) => part.text)
		.join('\n')
}

function getAssistantToolCalls(message: ChatMessage) {
	return message.role === 'assistant' ? message.tool_calls : undefined
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
	const cloned = cloneReversibleToolOp(op)
	return {
		...cloned,
		vaultPath: normalizedPath,
	}
}

function decodeBase64ToArrayBuffer(contentBase64: string) {
	if (typeof Buffer !== 'undefined') {
		const buffer = Buffer.from(contentBase64, 'base64')
		return buffer.buffer.slice(
			buffer.byteOffset,
			buffer.byteOffset + buffer.byteLength,
		) as ArrayBuffer
	}
	const binary = atob(contentBase64)
	const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer
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
			: { runState: 'idle' as const, pendingMessages: [] }
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
			canSend: true,
			canCreateFragment: !!activeSession && activeRuntime.runState === 'idle',
			canCompress:
				!!activeSession &&
				activeRuntime.runState === 'idle' &&
				this.getActiveFragment(activeSession).messages.length > 0,
			onNewSession: () => {
				void this.createSession()
			},
			onNewFragment: () => {
				this.createFragmentForActiveSession()
			},
			onCompressContext: async () => {
				await this.compressContext()
			},
			onSwitchSession: (sessionId: string) => {
				void this.switchSession(sessionId)
			},
			onDeleteSession: async (sessionId: string) => {
				await this.deleteSession(sessionId)
			},
			onSelectProvider: (providerId: string) => {
				this.selectProvider(providerId)
			},
			onSelectModel: (modelId: string) => {
				this.selectModel(modelId)
			},
			onSendMessage: async (text: string) => {
				await this.sendMessage(text)
			},
			onStopActiveRun: () => {
				this.stopActiveSessionRun()
			},
			onCancelTask: (taskId: string) => {
				this.cancelTask(taskId)
			},
			onDeleteMessage: (messageId: string) => {
				this.deleteMessage(messageId)
			},
			onRegenerateMessage: async (messageId: string) => {
				await this.regenerateMessage(messageId)
			},
			onRecallMessage: async (
				messageId: string,
				options?: { restoreFiles?: boolean },
			) => {
				await this.recallMessage(messageId, options)
			},
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

	async sendMessage(text: string) {
		await this.initialize()
		const normalizedText = text.trim()
		if (!normalizedText) {
			return
		}

		const session =
			this.getLoadedActiveSession() || (await this.createSession())
		if (!session || !this.validateSessionSelection(session)) {
			return
		}

		const runtime = this.getRuntime(session.id)
		if (runtime.runState !== 'idle' || runtime.processing) {
			runtime.pendingMessages.push(this.createPendingMessage(normalizedText))
			this.notify()
			return
		}

		this.appendUserMessage(
			this.getActiveFragment(session),
			normalizedText,
			session,
		)
		this.upsertSessionIndexItem(session, deriveTitle(session))
		runtime.runState = 'thinking'
		await this.persistSession(session)
		await this.persistMetaAndIndex()
		this.notify()
		await this.startSessionProcessor(session.id)
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
					error instanceof Error
						? error.message
						: i18n.t('chatbox.requestFailed'),
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
			const { tool_call_id: toolCallId } = target.message
			// Remove the matching tool call from the nearest preceding assistant message
			for (let i = idx - 1; i >= 0; i--) {
				const record = fragment.messages[i]
				if (record.message.role === 'user') break
				if (
					record.message.role === 'assistant' &&
					record.message.tool_calls?.some((tc) => tc.id === toolCallId)
				) {
					record.message = {
						...record.message,
						tool_calls: record.message.tool_calls.filter(
							(tc) => tc.id !== toolCallId,
						),
					}
					break
				}
			}
			fragment.messages.splice(idx, 1)
		} else {
			fragment.messages.splice(idx, 1)
		}
		void this.persistSession(session)
		this.notify()
	}

	async recallMessage(messageId: string, options?: { restoreFiles?: boolean }) {
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
		const recallRange = fragment.messages.slice(idx)
		const reversibleOps = recallRange.flatMap(
			(record) => record.reversibleOps ?? [],
		)
		try {
			if (options?.restoreFiles) {
				await this.restoreFilesForRecall(reversibleOps)
			}
			fragment.messages.splice(idx)
			await this.persistSession(session)
			this.notify()
		} catch (error) {
			new Notice(error instanceof Error ? error.message : String(error))
		}
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
										message: cloneMessage(message.message),
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
		const flattenedMessages = session.fragments.flatMap(
			(fragment) => fragment.messages,
		)

		return session.fragments.flatMap((fragment) => {
			const items = fragment.messages.flatMap((message) => {
				const toolMessage =
					message.message.role === 'tool' ? message.message : undefined
				if (
					message.message.role === 'assistant' &&
					!messageToText(message.message).trim() &&
					message.message.content?.every((part) => part.type === 'text') !==
						false &&
					Array.isArray(message.message.tool_calls) &&
					message.message.tool_calls.length > 0
				) {
					return []
				}

				return [
					{
						id: `message:${message.id}`,
						kind: 'message' as const,
						createdAt: message.createdAt,
						message,
						toolCall: toolMessage
							? flattenedMessages
									.slice(
										0,
										flattenedMessages.findIndex(
											(item) => item.id === message.id,
										),
									)
									.reverse()
									.flatMap((item) => getAssistantToolCalls(item.message) || [])
									.find((toolCall) => toolCall.id === toolMessage.tool_call_id)
							: undefined,
					},
				]
			})

			return [
				{
					id: `fragment:${fragment.id}`,
					kind: 'fragment' as const,
					createdAt: fragment.createdAt,
				},
				...items,
			]
		})
	}

	private collectOtherSessionTasks() {
		return Array.from(this.loadedSessions.values())
			.filter((session) => session.id !== this.activeSessionId)
			.flatMap((session) => session.tasks)
			.sort((left, right) => right.createdAt - left.createdAt)
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
				latestRuntime.pendingMessages.length
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
					const flushed = this.flushPendingMessages(session)
					if (!flushed) {
						runtime.runState = 'idle'
						this.notify()
						return
					}
				}

				runtime.runState = 'thinking'
				this.notify()

				const tools = this.createToolsForContext(session, 0, MAX_TASK_DEPTH)
				const response = await generateAssistantTurn({
					provider,
					model: model.id,
					messages: this.buildMessagesForFragment(fragment, session),
					tools,
					...session.inferenceParams,
				})

				if (this.deletedSessionIds.has(session.id)) {
					runtime.stopRequested = false
					runtime.runState = 'idle'
					return
				}

				if (runtime.stopRequested) {
					const record = this.createMessageRecord(response.message, {
						meta: { ...response.meta, modelId: model.id },
					})
					fragment.messages.push(record)
					this.finishStoppedSessionRun(session, fragment)
					await this.persistSession(session)
					return
				}

				const assistantRecord = this.createMessageRecord(response.message, {
					meta: { ...response.meta, modelId: model.id },
				})
				fragment.messages.push(assistantRecord)
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
			const activeProvider = getProviderById(
				this.plugin.settings.ai.providers,
				session.model?.providerId,
			)
			const activeModel = getModelById(activeProvider, session.model?.modelId)
			this.reportFatalError(
				session,
				error instanceof Error
					? error.message
					: i18n.t('chatbox.requestFailed'),
				{
					providerId: activeProvider?.id,
					providerName: activeProvider?.name,
					modelId: activeModel?.id,
					modelName: activeModel?.name,
				},
				this.getActiveFragment(session),
			)
			runtime.runState = 'idle'
			await this.persistSession(session)
		}
	}

	private flushPendingMessages(session: AISession) {
		const runtime = this.getRuntime(session.id)
		if (runtime.pendingMessages.length === 0) {
			return false
		}

		const mergedText = runtime.pendingMessages
			.map((item) => item.text.trim())
			.filter(Boolean)
			.join('\n\n')
		runtime.pendingMessages = []
		if (!mergedText) {
			this.notify()
			return false
		}

		const fragment = this.getActiveFragment(session)
		this.appendUserMessage(fragment, mergedText, session)
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
	) {
		const now = Date.now()
		fragment.updatedAt = now
		if (session) {
			session.updatedAt = now
		}
		fragment.messages.push(
			this.createMessageRecord({
				role: 'user',
				content: toTextParts(text),
			}),
		)
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
			this.finishTaskAsFailed(
				task,
				error instanceof Error
					? error.message
					: i18n.t('chatbox.requestFailed'),
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
				content: toTextParts(
					createSubagentSystemPrompt(task.depth < task.maxDepth),
				),
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
		const results = await Promise.all(
			toolCalls.map((toolCall) =>
				this.resolveSingleToolCall(toolCall, tools, context),
			),
		)

		return toolCalls.map((toolCall, index) => ({
			message: {
				role: 'tool' as const,
				content: toTextParts(
					typeof results[index].payload === 'string'
						? results[index].payload
						: JSON.stringify(results[index].payload, null, 2),
				),
				name: toolCall.function.name,
				tool_call_id: toolCall.id,
			},
			isError: results[index].isError,
			reversibleOps: results[index].reversibleOps,
		}))
	}

	private async resolveSingleToolCall(
		toolCall: AIToolCall,
		tools: AIToolDefinition[],
		context: AIToolExecutionContext,
	): Promise<ResolvedToolResult> {
		if (toolCall.function.name === 'spawn') {
			const payload = await this.startSpawnedTask(
				toolCall.function.arguments || '{}',
				context,
			)
			return {
				payload,
				isError: payload.status !== 'completed',
			}
		}

		const result = await this.executeToolCall(
			tools,
			toolCall.function.name,
			toolCall.function.arguments || '{}',
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

	private finishTaskAsCompleted(
		task: AITaskRecord,
		summary: string,
		sourceCount: number,
	) {
		if (task.status !== 'running') {
			return
		}
		mutateTaskRecord(
			task,
			toCompletedTask(
				task,
				summary || i18n.t('chatbox.task.emptyResult'),
				sourceCount,
				Date.now(),
			),
		)
		const session = this.loadedSessions.get(task.sessionId)
		if (session) {
			void this.persistSession(session)
		}
		this.notify()
		this.resolveTaskCompletion(task.id, this.buildTaskToolPayload(task))
		this.cleanupTaskTracking(task.id)
		if (session) {
			this.startQueuedTasksForSession(session)
		}
	}

	private finishTaskAsFailed(
		task: AITaskRecord,
		message: string,
		failureStage?: string,
		sourceCount?: number,
	) {
		if (task.status !== 'queued' && task.status !== 'running') {
			return
		}
		mutateTaskRecord(
			task,
			toFailedTask(task, message, Date.now(), failureStage, sourceCount),
		)
		const session = this.loadedSessions.get(task.sessionId)
		if (session) {
			void this.persistSession(session)
		}
		this.notify()
		this.resolveTaskCompletion(task.id, this.buildTaskToolPayload(task))
		this.cleanupTaskTracking(task.id)
		if (session) {
			this.startQueuedTasksForSession(session)
		}
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
		const session = this.loadedSessions.get(task.sessionId)
		if (session) {
			void this.persistSession(session)
		}
		this.notify()
		this.resolveTaskCompletion(task.id, this.buildTaskToolPayload(task))
		this.cleanupTaskTracking(task.id)
		if (session) {
			this.startQueuedTasksForSession(session)
		}
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

	private async executeToolCall(
		tools: AIToolDefinition[],
		name: string,
		args: string,
		context: AIToolExecutionContext,
	) {
		const tool = new Map(tools.map((item) => [item.name, item])).get(name)
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

	private buildMessagesForFragment(
		fragment: ChatFragment,
		session: AISession,
	): AIMessage[] {
		return [
			{
				role: 'system',
				content: toTextParts(
					session.systemPrompt || createMainSystemPrompt(MAX_TASK_DEPTH),
				),
			},
			...fragment.messages.map((item) => item.message),
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
		const restoreFiles = new Map<string, string>()

		for (const operation of earliestByPath.values()) {
			if (operation.operation === 'create') {
				deletePaths.add(operation.vaultPath)
				continue
			}
			if (operation.operation === 'update') {
				restoreFiles.set(operation.vaultPath, operation.before.contentBase64)
				continue
			}
			if (operation.before.kind === 'dir') {
				restoreDirs.add(operation.vaultPath)
				continue
			}
			restoreFiles.set(operation.vaultPath, operation.before.contentBase64)
		}

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
			await this.writeVaultFile(filePath, restoreFiles.get(filePath) || '')
		}
	}

	private async deleteVaultPathIfExists(path: string) {
		const target = this.plugin.app.vault.getAbstractFileByPath(path)
		if (!target) {
			return
		}
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
		await this.plugin.app.vault.createFolder(path)
	}

	private async writeVaultFile(path: string, contentBase64: string) {
		const data = decodeBase64ToArrayBuffer(contentBase64)
		const existing = this.plugin.app.vault.getAbstractFileByPath(path)
		if (existing && isVaultFolder(existing)) {
			throw new Error(
				`Unable to restore ${path}: a directory already exists there.`,
			)
		}
		if (existing && isVaultFile(existing)) {
			await this.plugin.app.vault.modifyBinary(existing as never, data)
			return
		}
		await this.plugin.app.vault.createBinary(path, data)
	}

	private removeUnmatchedToolCalls(fragment: ChatFragment) {
		const resolvedToolCallIds = new Set(
			fragment.messages.flatMap((item) =>
				item.message.role === 'tool' && item.message.tool_call_id
					? [item.message.tool_call_id]
					: [],
			),
		)

		fragment.messages = fragment.messages.filter((record) => {
			if (
				record.message.role !== 'assistant' ||
				!record.message.tool_calls?.length
			) {
				return true
			}

			const nextToolCalls = record.message.tool_calls.filter((toolCall) =>
				resolvedToolCallIds.has(toolCall.id),
			)
			const hasText = !!messageToText(record.message).trim()
			if (!hasText && nextToolCalls.length === 0) {
				return false
			}

			record.message =
				nextToolCalls.length > 0
					? {
							role: 'assistant',
							content: hasText
								? record.message.content || toTextParts('')
								: null,
							tool_calls: nextToolCalls,
						}
					: {
							role: 'assistant',
							content: record.message.content || toTextParts(''),
						}
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

	private getProviderOrThrow(session: AISession) {
		const provider = getProviderById(
			this.plugin.settings.ai.providers,
			session.model?.providerId,
		)
		if (!provider) {
			throw new Error(i18n.t('chatbox.errors.noProvider'))
		}
		assertProviderUsable(provider)
		return provider
	}

	private getProviderByIdOrThrow(providerId: string) {
		const provider = getProviderById(
			this.plugin.settings.ai.providers,
			providerId,
		)
		if (!provider) {
			throw new Error(i18n.t('chatbox.errors.noProvider'))
		}
		assertProviderUsable(provider)
		return provider
	}

	private getModelOrThrow(provider: AIProviderConfig, session: AISession) {
		const model = getModelById(provider, session.model?.modelId)
		if (!model) {
			throw new Error(i18n.t('chatbox.errors.noModel'))
		}
		return model
	}

	private getModelByIdsOrThrow(provider: AIProviderConfig, modelId: string) {
		const model = getModelById(provider, modelId)
		if (!model) {
			throw new Error(i18n.t('chatbox.errors.noModel'))
		}
		return model
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
		const normalized = this.getEmptyStateSelection()
		this.pendingProviderId = normalized.providerId
		this.pendingModelId = normalized.modelId
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
		new Notice(message)
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
