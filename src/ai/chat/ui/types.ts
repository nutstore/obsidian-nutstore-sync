import type {
	ChatDisplayBlock,
	AppUIMessage,
	ChatRunState,
	ChatSubmission,
	ChatAgentStatus,
} from '~/ai/chat/types'
import type { LanguageModelUsage } from 'ai'
import type { UserContextItem } from '~/ai/chat/context/user-context'
import type { ChatModalMountTarget } from '~/ai/chat/ui/modal-mount'

interface ChatModelOption {
	id: string
	name: string
}

export interface ChatProviderOption {
	id: string
	name: string
	models: ChatModelOption[]
}

interface ChatSessionHistoryItem {
	id: string
	title: string
	createdAt: number
	updatedAt: number
}

export interface ChatMcpServerOption {
	name: string
	connected: boolean
	toolCount: number
	/** Whether this MCP server is disabled for the active session. */
	disabled: boolean
}

export interface ChatTimelineMessageItem {
	createdAt: number
	message: AppUIMessage
	displayBlocks: ChatDisplayBlock[]
	showHeader: boolean
}

export interface ChatAgentView {
	id: string
	type: string
	status: ChatAgentStatus
	createdAt: number
	startedAt?: number
	finishedAt?: number
	timeline: ChatTimelineMessageItem[]
}

interface ChatboxViewModel {
	loading: boolean
	title: string
	activeContextItems: UserContextItem[]
	sessionHistory: ChatSessionHistoryItem[]
	activeSessionId?: string
	timeline: ChatTimelineMessageItem[]
	agentsById: Record<string, ChatAgentView>
	otherBusySessionIds: string[]
	providers: ChatProviderOption[]
	selectedProviderId?: string
	selectedModelId?: string
	runState: ChatRunState
	draft: ChatSubmission
	pending: ChatSubmission[]
	canSend: boolean
	canCompress: boolean
	/** Globally enabled MCP servers with per-session state, for the session MCP popover. */
	mcpServers: ChatMcpServerOption[]
	/**
	 * Most recent assistant token usage record in the active agent context, or
	 * undefined when no usage data is available yet. Carries inputTokens,
	 * outputTokens, and their breakdowns — the UI decides how to present them.
	 */
	usage?: LanguageModelUsage
	/** Total context window (tokens) of the active model, or undefined when no model is selected. */
	contextWindow?: number
}

export interface RecallMessageResult {
	text: string
	userContext: UserContextItem[]
}

export interface ChatboxProps extends ChatboxViewModel {
	onNewSession: () => void
	onCompressContext: () => Promise<void>
	onSwitchSession: (sessionId: string) => void
	onExportSession: (
		sessionId: string,
		modalMountTarget?: ChatModalMountTarget,
	) => Promise<void>
	onDeleteSession: (sessionId: string) => Promise<void>
	onSelectProvider: (providerId: string) => void
	onSelectModel: (modelId: string) => void
	onSendMessage: (
		text: string,
		activeContextItems?: UserContextItem[],
	) => Promise<boolean>
	onUpdateInputDraft: (text: string) => void
	onStopActiveRun?: () => void
	onAddUserContext: (item: UserContextItem) => void
	onRemoveUserContext: (index: number) => void
	onResolvePendingContextItem: (
		id: string,
		replacement: UserContextItem | null,
	) => void
	onDropContextItem: (path: string) => Promise<void> | void
	onCaptureActiveContext?: () => void
	onModalHostChange?: (rootEl?: HTMLElement) => void
	onDeleteMessage?: (messageId: string) => void
	onRegenerateMessage?: (messageId: string) => void
	onRecallMessage?: (
		messageId: string,
		options?: { restoreFiles?: boolean },
	) => Promise<RecallMessageResult | void> | void
	onRecallHasReversibleOps?: (messageId: string) => boolean
	onToggleSessionMcpServer?: (serverName: string) => void
	onOpenFileChange?: (vaultPath: string, line?: number) => Promise<void> | void
	onResolveResourceDataUrl?: (
		path: string,
		mediaType: string,
	) => Promise<string | undefined>
	renderMarkdown?: (
		el: HTMLElement,
		markdown: string,
		options?: { streaming?: boolean },
	) => void | (() => void) | Promise<void | (() => void)>
}

export interface ChatboxController {
	update: (props: ChatboxProps) => void
	destroy: () => void
}
