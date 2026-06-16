import type {
	ChatDisplayBlock,
	ChatMessageRecord,
	ChatPendingMessage,
	ChatRunState,
	ChatTaskRecord,
} from '~/chat/domain'
import type { UserContextItem } from '~/chat/user-context'

export type {
	ChatDisplayBlock,
	ChatMessageRecord,
	ChatPendingMessage,
	ChatRunState,
	ChatTaskRecord,
	ReversibleToolOp,
} from '~/chat/domain'
export type { UserContextItem } from '~/chat/user-context'

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
	displayBlocks: ChatDisplayBlock[]
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
	otherBusySessionIds: string[]
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
	onRecallHasReversibleOps?: (messageId: string) => boolean
	renderMarkdown?: (
		el: HTMLElement,
		markdown: string,
	) => void | (() => void) | Promise<void | (() => void)>
}

export interface ChatboxController {
	update: (props: ChatboxProps) => void
	destroy: () => void
}
