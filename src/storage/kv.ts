import type { ChatSessionIndexItem } from '~/ai/chat/domain'
import type { PersistedChatSession } from '~/ai/chat/session/session-persistence'
import { StatModel } from '~/model/stat.model'
import { SyncRecordModel } from '~/model/sync-record.model'
import { createIndexedDbStorage } from './indexed-db-storage'

const DB_NAME = 'Nutstore_Plugin_Cache'

function createRecoverableStorage<T>(storeName: string) {
	return createIndexedDbStorage<T>(DB_NAME, storeName)
}

export const syncRecordKV =
	createRecoverableStorage<Map<string, SyncRecordModel>>('sync_record')

export const blobKV = createRecoverableStorage<Blob>('base_blob_store')

export interface RemoteUnreadableEntry {
	path: string
	operation: 'list' | 'stat'
	status?: string
}

export interface TraverseWebDAVCache {
	schemaVersion?: number
	rootCursor: string
	queue: string[]
	/** Unresolved directory or file reads; an empty queue alone does not imply completeness. */
	pendingVerification?: string[]
	/** Remote entries whose PROPFIND returned non-200 status; protected by SyncScope across runs. */
	unreadablePaths?: RemoteUnreadableEntry[]
	nodes: Record<string, StatModel[]>
	/** Timestamp (ms) of the last completed root-to-leaf full scan + delta catch-up. */
	lastFullScanAt?: number
}

export const traverseWebDAVKV = createRecoverableStorage<TraverseWebDAVCache>(
	'traverse_webdav_cache',
)

export interface CacheUploadMeta {
	nodesHash: string
}

export const cacheUploadMetaKV =
	createRecoverableStorage<CacheUploadMeta>('cache_upload_meta')

export interface ChatMetaRecord {
	activeSessionId?: string
	orderedSessionIds: string[]
}

export const chatSessionKV =
	createRecoverableStorage<PersistedChatSession>('chat_sessions')

export const chatMetaKV = createRecoverableStorage<
	ChatMetaRecord | ChatSessionIndexItem[]
>('chat_meta')
