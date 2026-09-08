import type {
	AppUIMessage,
	ReversibleToolOp,
	ToolTiming,
} from '~/ai/chat/types'
import type { ChatSessionIndexItem } from '~/ai/chat/domain'

export interface RegenerationTransaction {
	targetMessageId: string
	targetToolCallIds: string[]
	originalTimeline: AppUIMessage[]
	originalOperations: Record<string, ReversibleToolOp[]>
	originalToolTimings: Record<string, ToolTiming>
	originalReadVaultPaths?: string[]
	originalSessionUpdatedAt: number
	originalSessionIndexItem?: ChatSessionIndexItem
	originalSessionIndexPosition: number
	prefixLength: number
	suffix: AppUIMessage[]
}
