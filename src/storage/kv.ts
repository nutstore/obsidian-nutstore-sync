import localforage from 'localforage'
import type { ChatSession, ChatSessionIndexItem } from '~/ai/chat/domain'
import { StatModel } from '~/model/stat.model'
import { SyncRecordModel } from '~/model/sync-record.model'
import useStorage from './use-storage'

const DB_NAME = 'Nutstore_Plugin_Cache'

function createRecoverableStorage<T>(storeName: string) {
	return useStorage<T>({
		getFreshInstance: () =>
			localforage.createInstance({
				name: DB_NAME,
				storeName,
			}),
		maxRetries: 1,
	})
}

export const syncRecordKV =
	createRecoverableStorage<Map<string, SyncRecordModel>>('sync_record')

export const blobKV = createRecoverableStorage<Blob>('base_blob_store')

export interface TraverseWebDAVCache {
	rootCursor: string
	queue: string[]
	nodes: Record<string, StatModel[]>
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
	createRecoverableStorage<ChatSession>('chat_sessions')

export const chatMetaKV = createRecoverableStorage<
	ChatMetaRecord | ChatSessionIndexItem[]
>('chat_meta')
