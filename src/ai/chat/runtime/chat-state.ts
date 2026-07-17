import type { ChatSession } from '~/ai/chat/domain'

import type { ChatRunState, ChatSubmission } from '~/ai/chat/types'
import type { ChatSessionIndexItem } from '~/ai/chat/domain'
import type { IFileSystem } from 'just-bash/browser'

export interface SessionRuntimeState {
	runState: ChatRunState
	processing?: Promise<void>
	stopRequested?: boolean
	abortController?: AbortController
	bashScratch?: IFileSystem
	draft: ChatSubmission
	pending: ChatSubmission[]
}

interface TaskModelSelection {
	providerId: string
	modelId: string
}

export class ChatState {
	readonly loadedSessions = new Map<string, ChatSession>()
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
	chatModalHostEl?: HTMLElement
	initialization?: Promise<void>
}
