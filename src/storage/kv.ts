import localforage from 'localforage'
import { StatModel } from '~/model/stat.model'
import { SyncRecordModel } from '~/model/sync-record.model'
import useStorage from './use-storage'

const DB_NAME = 'Nutstore_Plugin_Cache'

export const syncRecordKV = useStorage<Map<string, SyncRecordModel>>(
	localforage.createInstance({
		name: DB_NAME,
		storeName: 'sync_record',
	}),
)

export const blobKV = useStorage<Blob>(
	localforage.createInstance({
		name: DB_NAME,
		storeName: 'base_blob_store',
	}),
)

export interface TraverseWebDAVCache {
	rootCursor: string
	queue: string[]
	nodes: Record<string, StatModel[]>
	processedCount: number
}

export const traverseWebDAVKV = useStorage<TraverseWebDAVCache>(
	localforage.createInstance({
		name: DB_NAME,
		storeName: 'traverse_webdav_cache',
	}),
)
