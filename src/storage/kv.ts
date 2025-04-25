import localforage from 'localforage'
import { DeltaResponse } from '~/api/delta'
import { StatModel } from '~/model/stat.model'
import { SyncRecordModel } from '~/model/sync-record.model'
import useStorage from './use-storage'

const DB_NAME = 'Nutstore_Plugin_Cache'

interface DeltaCache {
	files: StatModel[]
	originCursor: string
	deltas: DeltaResponse[]
}

export const deltaCacheKV = useStorage<DeltaCache>(
	localforage.createInstance({
		name: DB_NAME,
		storeName: 'delta_cache',
	}),
)

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
