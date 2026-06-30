import type { AISession, AITaskRecord } from '~/ai/core/types'
import type { ChatRunState, ChatSubmission } from '~/ai/chat/types'
import type { ChatSessionIndexItem } from '~/ai/chat/domain'

export interface SessionRuntimeState {
	runState: ChatRunState
	processing?: Promise<void>
	stopRequested?: boolean
	abortController?: AbortController
	draft: ChatSubmission
	pending: ChatSubmission[]
}

export interface DeferredTaskCompletion {
	promise: Promise<Record<string, unknown>>
	resolve: (payload: Record<string, unknown>) => void
	settled: boolean
}

export interface TaskModelSelection {
	providerId: string
	modelId: string
}

export class ChatState {
	readonly loadedSessions = new Map<string, AISession>()
	readonly autoApproveRequestsBySessionId = new Map<string, Set<string>>()
	sessionIndex: ChatSessionIndexItem[] = []
	readonly deletedSessionIds = new Set<string>()
	pendingProviderId?: string
	pendingModelId?: string
	activeSessionId?: string
	readonly runtimeBySessionId = new Map<string, SessionRuntimeState>()
	readonly taskModelSelection = new Map<
		string,
		TaskModelSelection | undefined
	>()
	readonly pendingTaskCompletions = new Map<string, DeferredTaskCompletion>()
	chatModalHostEl?: HTMLElement
	initialization?: Promise<void>

	findLoadedSessionByTaskId(taskId: string): AISession | undefined {
		for (const session of this.loadedSessions.values()) {
			if (session.tasks.some((task: AITaskRecord) => task.id === taskId)) {
				return session
			}
		}
		return undefined
	}
}
