import type {
	AssistantModelMessage,
	FinishReason,
	ImagePart,
	LanguageModelUsage,
	ModelMessage,
	TextPart,
	ToolCallPart,
	ToolModelMessage,
	UserModelMessage,
} from 'ai'
import type { UserContextItem } from '~/chat/user-context'

export type { UserContextItem } from '~/chat/user-context'

export type {
	AssistantModelMessage,
	ImagePart,
	ModelMessage,
	TextPart,
	ToolCallPart,
	ToolModelMessage,
	UserModelMessage,
} from 'ai'

// ReasoningPart is not directly exported from 'ai'; derive it from AssistantModelMessage
type AssistantContentArray = Extract<
	AssistantModelMessage['content'],
	readonly unknown[]
>
export type ReasoningPart = Extract<
	AssistantContentArray[number],
	{ type: 'reasoning' }
>

export type ChatMessage = ModelMessage
export type ChatAssistantMessage = AssistantModelMessage
export type ChatUserMessage = UserModelMessage
export type ChatToolMessage = ToolModelMessage
export type ChatMessageContentPart =
	| TextPart
	| ImagePart
	| ReasoningPart
	| ToolCallPart

export interface ReversibleCompressedContent {
	compress: 'deflate'
	blob: Blob
}

export interface ReversibleFileSnapshot {
	kind: 'file'
	contentCompressed?: ReversibleCompressedContent
	contentBase64?: string
}

export type ReversibleToolOp =
	| {
			vaultPath: string
			operation: 'create'
			before: { kind: 'file' | 'dir' }
	  }
	| {
			vaultPath: string
			operation: 'update'
			before: ReversibleFileSnapshot
	  }
	| {
			vaultPath: string
			operation: 'delete'
			before: ReversibleFileSnapshot | { kind: 'dir' }
	  }

export type ChatRunState =
	| 'idle'
	| 'thinking'
	| 'compressing'
	| 'waiting_for_tools'

export interface ChatMessageMeta {
	providerId?: string
	providerName?: string
	modelId?: string
	modelName?: string
	usage?: LanguageModelUsage
	finishReason?: FinishReason
	responseId?: string
}

export interface WorkspaceContextDelta {
	hash: string
	key: string
	content: unknown
}

export interface ChatMessageRecord {
	id: string
	createdAt: number
	message: ChatMessage
	workspaceContextDelta?: WorkspaceContextDelta[]
	meta?: ChatMessageMeta
	isError?: boolean
	reversibleOps?: ReversibleToolOp[]
	userContext?: UserContextItem[]
}

export interface ChatTaskBase {
	id: string
	sessionId: string
	parentTaskId?: string
	depth: number
	maxDepth: number
	title: string
	prompt: string
	createdAt: number
}

export interface QueuedChatTask extends ChatTaskBase {
	status: 'queued'
}

export interface RunningChatTask extends ChatTaskBase {
	status: 'running'
	startedAt: number
}

export interface CompletedChatTask extends ChatTaskBase {
	status: 'completed'
	startedAt: number
	finishedAt: number
	summary: string
	sourceCount: number
}

export interface FailedChatTask extends ChatTaskBase {
	status: 'failed'
	finishedAt: number
	error: string
	summary?: string
	failureStage?: string
	startedAt?: number
	sourceCount?: number
}

export interface CancelledChatTask extends ChatTaskBase {
	status: 'cancelled'
	finishedAt: number
	cancelReason: string
	summary?: string
	startedAt?: number
}

export type ChatTaskRecord =
	| QueuedChatTask
	| RunningChatTask
	| CompletedChatTask
	| FailedChatTask
	| CancelledChatTask

export interface ChatPendingMessage {
	id: string
	createdAt: number
	text: string
}

export interface ChatModelOption {
	id: string
	name: string
}

export interface ChatProviderOption {
	id: string
	name: string
	models: ChatModelOption[]
}

export interface ChatSessionHistoryItem {
	id: string
	title: string
	createdAt: number
	updatedAt: number
}

export interface ChatTimelineFragmentItem {
	id: string
	kind: 'fragment'
	createdAt: number
}

export interface ChatTimelineMessageItem {
	id: string
	kind: 'message'
	createdAt: number
	message: ChatMessageRecord
	toolCall?: ToolCallPart
}

export type ChatTimelineItem =
	| ChatTimelineFragmentItem
	| ChatTimelineMessageItem

export interface ChatboxViewModel {
	title: string
	sessionHistory: ChatSessionHistoryItem[]
	activeSessionId?: string
	timeline: ChatTimelineItem[]
	currentSessionTasks: ChatTaskRecord[]
	otherSessionTasks: ChatTaskRecord[]
	providers: ChatProviderOption[]
	selectedProviderId?: string
	selectedModelId?: string
	runState: ChatRunState
	pendingMessages: ChatPendingMessage[]
	pendingUserContext: UserContextItem[]
	pendingInputDraft: string
	canSend: boolean
	canCreateFragment: boolean
	canCompress: boolean
}

export interface RecallMessageResult {
	text: string
	userContext: UserContextItem[]
}

export interface ChatboxProps extends ChatboxViewModel {
	onNewSession: () => void
	onNewFragment: () => void
	onCompressContext: () => Promise<void>
	onSwitchSession: (sessionId: string) => void
	onExportSession: (sessionId: string) => Promise<void>
	onDeleteSession: (sessionId: string) => Promise<void>
	onSelectProvider: (providerId: string) => void
	onSelectModel: (modelId: string) => void
	onSendMessage: (text: string) => Promise<boolean>
	onUpdateInputDraft: (text: string) => void
	onStopActiveRun?: () => void
	onAddUserContext: (item: UserContextItem) => void
	onRemoveUserContext: (index: number) => void
	onDropContextItem: (path: string) => void
	onCancelTask?: (taskId: string) => void
	onDeleteMessage?: (messageId: string) => void
	onRegenerateMessage?: (messageId: string) => void
	onRecallMessage?: (
		messageId: string,
		options?: { restoreFiles?: boolean },
	) => Promise<RecallMessageResult | void> | void
	renderMarkdown?: (
		el: HTMLElement,
		markdown: string,
	) => void | (() => void) | Promise<void | (() => void)>
}
