export type {
	CancelledChatTask,
	ChatAssistantMessage,
	ChatAssistantMessageWithContent,
	ChatAssistantMessageWithToolCalls,
	ChatImageUrlPart,
	ChatMessage,
	ChatMessageContentPart,
	ChatMessageMeta,
	ChatMessageRecord,
	ChatPendingMessage,
	ChatRunState,
	ChatSystemMessage,
	ChatTaskBase,
	ChatTaskRecord,
	ChatTextPart,
	ChatToolCall,
	ChatToolMessage,
	ChatUnknownPart,
	ChatUsage,
	ChatUserMessage,
	CompletedChatTask,
	FailedChatTask,
	QueuedChatTask,
	ReversibleCompressedContent,
	ReversibleFileSnapshot,
	ReversibleToolOp,
	RunningChatTask,
	WorkspaceContextDelta,
} from '../components/solid-js'

import type {
	CancelledChatTask,
	ChatImageUrlPart,
	ChatMessage,
	ChatMessageRecord,
	ChatTaskBase,
	ChatTaskRecord,
	ChatTextPart,
	ChatUnknownPart,
	ChatUsage,
	CompletedChatTask,
	FailedChatTask,
	QueuedChatTask,
	ReversibleToolOp,
	RunningChatTask,
} from '../components/solid-js'

export interface ChatFragment {
	id: string
	createdAt: number
	updatedAt: number
	summary?: string
	messages: ChatMessageRecord[]
}

export interface ChatSessionPermissions {
	allow: { operation: string; path: string }[]
}

export interface ChatSession {
	id: string
	createdAt: number
	updatedAt: number
	model?: { providerId: string; modelId: string }
	systemPrompt?: string
	inferenceParams?: { temperature?: number; maxTokens?: number }
	fragments: ChatFragment[]
	activeFragmentId: string
	tasks: ChatTaskRecord[]
	permissions?: ChatSessionPermissions
}

export interface ChatSessionIndexItem {
	id: string
	title: string
	createdAt: number
	updatedAt: number
}

export function cloneUsage(usage?: ChatUsage) {
	return usage
		? {
				...usage,
			}
		: undefined
}

export function cloneMessage(message: ChatMessage): ChatMessage {
	return {
		...message,
		content: message.content?.map((part) => {
			if (part.type === 'image_url') {
				return {
					type: 'image_url',
					image_url: {
						...part.image_url,
					},
				} satisfies ChatImageUrlPart
			}
			if (part.type === 'unknown') {
				return {
					type: 'unknown',
					value: part.value,
				} satisfies ChatUnknownPart
			}
			return {
				type: 'text',
				text: part.text,
			} satisfies ChatTextPart
		}) as ChatMessage['content'],
		tool_calls:
			'tool_calls' in message && message.tool_calls
				? message.tool_calls.map((toolCall) => ({
						...toolCall,
						function: {
							...toolCall.function,
						},
					}))
				: undefined,
	} as ChatMessage
}

export function cloneReversibleToolOp(op: ReversibleToolOp): ReversibleToolOp {
	switch (op.operation) {
		case 'create':
			return {
				vaultPath: op.vaultPath,
				operation: 'create',
				before: { kind: op.before.kind },
			}
		case 'update':
			return {
				vaultPath: op.vaultPath,
				operation: 'update',
				before: {
					kind: 'file',
					contentCompressed: op.before.contentCompressed
						? { ...op.before.contentCompressed }
						: undefined,
					contentBase64: op.before.contentBase64,
				},
			}
		case 'delete':
			return {
				vaultPath: op.vaultPath,
				operation: 'delete',
				before:
					op.before.kind === 'dir'
						? { kind: 'dir' }
						: {
								kind: 'file',
								contentCompressed: op.before.contentCompressed
									? { ...op.before.contentCompressed }
									: undefined,
								contentBase64: op.before.contentBase64,
							},
			}
	}
}

export function cloneMessageRecord(
	record: ChatMessageRecord,
): ChatMessageRecord {
	return {
		...record,
		reversibleOps: record.reversibleOps?.map(cloneReversibleToolOp),
		message: cloneMessage(record.message),
		meta: record.meta
			? {
					...record.meta,
					usage: cloneUsage(record.meta.usage),
				}
			: undefined,
	}
}

export function cloneTask(task: ChatTaskRecord): ChatTaskRecord {
	return {
		...task,
	}
}

export function cloneSession(session: ChatSession): ChatSession {
	return {
		...session,
		model: session.model ? { ...session.model } : undefined,
		inferenceParams: session.inferenceParams
			? { ...session.inferenceParams }
			: undefined,
		fragments: session.fragments.map((fragment) => ({
			...fragment,
			messages: fragment.messages.map(cloneMessageRecord),
		})),
		tasks: session.tasks.map(cloneTask),
	}
}

export function isTerminalTask(task: ChatTaskRecord) {
	return (
		task.status === 'completed' ||
		task.status === 'failed' ||
		task.status === 'cancelled'
	)
}

export function createQueuedTask(task: ChatTaskBase): QueuedChatTask {
	return {
		...task,
		status: 'queued',
	}
}

export function createRunningTask(
	task: ChatTaskBase,
	startedAt: number,
): RunningChatTask {
	return {
		...task,
		status: 'running',
		startedAt,
	}
}

export function toRunningTask(
	task: QueuedChatTask,
	startedAt: number,
): RunningChatTask {
	return {
		...task,
		status: 'running',
		startedAt,
	}
}

export function toCompletedTask(
	task: RunningChatTask,
	summary: string,
	sourceCount: number,
	finishedAt: number,
): CompletedChatTask {
	return {
		...task,
		status: 'completed',
		summary,
		sourceCount,
		finishedAt,
	}
}

export function toFailedTask(
	task: QueuedChatTask | RunningChatTask,
	error: string,
	finishedAt: number,
	failureStage?: string,
	sourceCount?: number,
): FailedChatTask {
	return {
		...task,
		status: 'failed',
		error,
		finishedAt,
		failureStage,
		...(task.status === 'running' ? { startedAt: task.startedAt } : {}),
		...(typeof sourceCount === 'number' ? { sourceCount } : {}),
	}
}

export function toCancelledTask(
	task: QueuedChatTask | RunningChatTask,
	cancelReason: string,
	finishedAt: number,
	summary?: string,
): CancelledChatTask {
	return {
		...task,
		status: 'cancelled',
		cancelReason,
		finishedAt,
		summary,
		...(task.status === 'running' ? { startedAt: task.startedAt } : {}),
	}
}

export function mutateTaskRecord(target: ChatTaskRecord, next: ChatTaskRecord) {
	for (const key of [
		'status',
		'startedAt',
		'finishedAt',
		'summary',
		'error',
		'failureStage',
		'cancelReason',
		'sourceCount',
	] as const) {
		delete (target as unknown as Record<string, unknown>)[key]
	}
	Object.assign(target, next)
	return target
}
