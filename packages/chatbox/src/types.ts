export interface ChatUsage {
	inputTokens?: number
	outputTokens?: number
	totalTokens?: number
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
			before: { kind: 'file'; contentBase64: string }
	  }
	| {
			vaultPath: string
			operation: 'delete'
			before: { kind: 'file'; contentBase64: string } | { kind: 'dir' }
	  }

export type ChatRunState =
	| 'idle'
	| 'thinking'
	| 'compressing'
	| 'waiting_for_tools'

export interface ChatTextPart {
	type: 'text'
	text: string
}

export interface ChatImageUrlPart {
	type: 'image_url'
	image_url: {
		url: string
	}
}

export interface ChatUnknownPart {
	type: 'unknown'
	value: unknown
}

export type ChatMessageContentPart =
	| ChatTextPart
	| ChatImageUrlPart
	| ChatUnknownPart

export interface ChatToolCall {
	id: string
	type: 'function'
	function: {
		name: string
		arguments: string
	}
}

export interface ChatMessageMeta {
	providerId?: string
	providerName?: string
	modelId?: string
	modelName?: string
	usage?: ChatUsage
}

export interface ChatSystemMessage {
	role: 'system'
	content: ChatMessageContentPart[]
}

export interface ChatUserMessage {
	role: 'user'
	content: ChatMessageContentPart[]
}

export interface ChatAssistantMessageWithContent {
	role: 'assistant'
	content: ChatMessageContentPart[]
	tool_calls?: ChatToolCall[]
	interleaved?: Record<string, unknown>
}

export interface ChatAssistantMessageWithToolCalls {
	role: 'assistant'
	content?: null
	tool_calls: ChatToolCall[]
	interleaved?: Record<string, unknown>
}

export interface ChatToolMessage {
	role: 'tool'
	content: ChatMessageContentPart[]
	name: string
	tool_call_id: string
}

export type ChatAssistantMessage =
	| ChatAssistantMessageWithContent
	| ChatAssistantMessageWithToolCalls

export type ChatMessage =
	| ChatSystemMessage
	| ChatUserMessage
	| ChatAssistantMessage
	| ChatToolMessage

export interface ChatMessageRecord {
	id: string
	createdAt: number
	message: ChatMessage
	meta?: ChatMessageMeta
	isError?: boolean
	reversibleOps?: ReversibleToolOp[]
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
	toolCall?: ChatToolCall
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
	canSend: boolean
	canCreateFragment: boolean
	canCompress: boolean
}

export interface ChatboxProps extends ChatboxViewModel {
	onNewSession: () => void
	onNewFragment: () => void
	onCompressContext: () => Promise<void>
	onSwitchSession: (sessionId: string) => void
	onDeleteSession: (sessionId: string) => Promise<void>
	onSelectProvider: (providerId: string) => void
	onSelectModel: (modelId: string) => void
	onSendMessage: (text: string) => Promise<void>
	onStopActiveRun?: () => void
	onCancelTask?: (taskId: string) => void
	onDeleteMessage?: (messageId: string) => void
	onRegenerateMessage?: (messageId: string) => void
	onRecallMessage?: (
		messageId: string,
		options?: { restoreFiles?: boolean },
	) => Promise<void> | void
	renderMarkdown?: (
		el: HTMLElement,
		markdown: string,
	) => void | (() => void) | Promise<void | (() => void)>
}
