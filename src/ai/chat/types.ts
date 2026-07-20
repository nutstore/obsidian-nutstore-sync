import type {
	AssistantModelMessage,
	DynamicToolUIPart,
	FilePart,
	FinishReason,
	LanguageModelUsage,
	ModelMessage,
	UIMessage,
	UIMessagePart,
	UITools,
	TextPart,
	ToolCallPart,
} from 'ai'

import { z } from 'zod/mini'
import type { UserContextItem } from '~/ai/chat/context/user-context'

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

interface ContextCheckpointData {
	mode: 'summary' | 'reset'
	summary?: string
	preservedTurnCount?: number
}

export interface SystemNotificationData {
	kind: 'task-result-ready'
	taskId: string
	resultPath: string
}

type ChatDataParts = {
	'workspace-context': { deltas: WorkspaceContextDelta[] }
	'user-context': { items: UserContextItem[] }
	'context-checkpoint': ContextCheckpointData
	'system-notification': SystemNotificationData
	'model-file': { file: FilePart }
	todos: { items: ChatTodoItem[] }
}

interface ChatMessageMetadata {
	createdAt: number
	llm?: ChatMessageMeta
	status?: 'error'
}

export type AppUIMessage = UIMessage<
	ChatMessageMetadata,
	ChatDataParts,
	UITools
>

export type AppUIMessagePart = UIMessagePart<ChatDataParts, UITools>

export interface ChatDisplayContentBlock {
	kind: 'content'
	parts: Array<
		Extract<AppUIMessagePart, { type: 'text' | 'reasoning' }> | FilePart
	>
}

export interface ChatDisplayToolCallBlock {
	kind: 'tool-call'
	toolCall: DynamicToolUIPart
	timing?: ToolTiming
	todos?: ChatTodoItem[]
}

export interface ChatDisplaySystemNotificationBlock {
	kind: 'system-notification'
	notification: SystemNotificationData
}

export type ChatDisplayBlock =
	| ChatDisplayContentBlock
	| ChatDisplayToolCallBlock
	| ChatDisplaySystemNotificationBlock

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

/** Persisted V1 record. Kept only for lossless on-load migration. */
export interface LegacyChatMessageRecord {
	id: string
	createdAt: number
	message: ModelMessage
	workspaceContextDelta?: WorkspaceContextDelta[]
	meta?: ChatMessageMeta
	isError?: boolean
	reversibleOps?: ReversibleToolOp[]
	userContext?: UserContextItem[]
	todos?: ChatTodoItem[]
}

export type ChatAgentStatus =
	| 'idle'
	| 'queued'
	| 'running'
	| 'completed'
	| 'failed'
	| 'cancelled'

export interface ToolTiming {
	startedAt: number
	finishedAt?: number
}

export interface ChatAgentState {
	id: string
	type: string
	status: ChatAgentStatus
	createdAt: number
	startedAt?: number
	finishedAt?: number
	timeline: AppUIMessage[]
	pendingInputs: AppUIMessage[]
	operations: Record<string, ReversibleToolOp[]>
	toolTimings: Record<string, ToolTiming>
	readVaultPaths?: string[]
	subagents: Record<string, ChatAgentState>
}

const chatTodoStatusSchema = z.enum([
	'pending',
	'in_progress',
	'completed',
	'cancelled',
])

const chatTodoPrioritySchema = z.enum(['high', 'medium', 'low'])

export const chatTodoItemSchema = z.object({
	content: z.string().check(z.trim(), z.minLength(1)),
	status: chatTodoStatusSchema,
	priority: z._default(chatTodoPrioritySchema, 'medium'),
})

export type ChatTodoStatus = z.infer<typeof chatTodoStatusSchema>
export type ChatTodoItem = z.infer<typeof chatTodoItemSchema>

export interface ChatSubmission {
	text: string
	userContext: UserContextItem[]
}
