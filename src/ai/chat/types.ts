import type {
	AssistantModelMessage,
	FilePart,
	FinishReason,
	LanguageModelUsage,
	ModelMessage,
	TextPart,
	ToolCallPart,
	ToolModelMessage,
	UserModelMessage,
} from 'ai'
import { z } from 'zod'
import type { UserContextItem } from '~/ai/chat/context/user-context'

export type {
	AssistantModelMessage,
	FilePart,
	TextPart,
	ToolCallPart,
	ToolModelMessage,
	UserModelMessage,
}

export type ChatMessage = ModelMessage
export type ChatAssistantMessage = AssistantModelMessage
export type ChatUserMessage = UserModelMessage
export type ChatToolMessage = ToolModelMessage

type AssistantContentArray = Extract<
	AssistantModelMessage['content'],
	readonly unknown[]
>

export type ReasoningPart = Extract<
	AssistantContentArray[number],
	{ type: 'reasoning' }
>

export type ChatMessageContentPart =
	| TextPart
	| FilePart
	| ReasoningPart
	| ToolCallPart

export interface ChatDisplayContentBlock {
	kind: 'content'
	parts: Array<Exclude<ChatMessageContentPart, ToolCallPart>>
}

export interface ChatDisplayToolCallBlock {
	kind: 'tool-call'
	toolCall: ToolCallPart
	toolMessage?: ChatMessageRecord
}

export interface ChatDisplayToolResultBlock {
	kind: 'tool-result'
	toolMessage: ChatMessageRecord
}

export type ChatDisplayBlock =
	| ChatDisplayContentBlock
	| ChatDisplayToolCallBlock
	| ChatDisplayToolResultBlock

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
	todos?: ChatTodoItem[]
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

export const chatTodoStatusSchema = z.enum([
	'pending',
	'in_progress',
	'completed',
	'cancelled',
])

export const chatTodoPrioritySchema = z.enum(['high', 'medium', 'low'])

export const chatTodoItemSchema = z.object({
	content: z.string().trim().min(1),
	status: chatTodoStatusSchema,
	priority: chatTodoPrioritySchema.default('medium'),
})

export type ChatTodoStatus = z.infer<typeof chatTodoStatusSchema>
export type ChatTodoPriority = z.infer<typeof chatTodoPrioritySchema>
export type ChatTodoItem = z.infer<typeof chatTodoItemSchema>

export interface ChatSubmission {
	text: string
	userContext: UserContextItem[]
}
