import localforage from 'localforage'
import { DeltaResponse } from '~/api/delta'
import { StatModel } from '~/model/stat.model'
import { SyncRecordModel } from '~/model/sync-record.model'

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

function useStorage<T = any>(instance: LocalForage) {
	function set(key: string, value: T) {
		return instance.setItem(key, value)
	}

	function get(key: string) {
		return instance.getItem<T>(key)
	}

	function unset(key: string) {
		return instance.removeItem(key)
	}

	function clear() {
		return instance.clear()
	}

	async function dump() {
		const keys = await instance.keys()
		const data: Record<string, T> = {}
		for (const key of keys) {
			const val = await instance.getItem<T>(key)
			if (val) {
				data[key] = val
			}
		}
		return data
	}

	async function restore(data: Record<string, any>) {
		if (!data || typeof data !== 'object') {
			throw new Error('Invalid data format for restore')
		}
		const temp = await dump()
		try {
			await instance.clear()
			for (const key in data) {
				await instance.setItem(key, data[key])
			}
		} catch {
			await instance.clear()
			for (const key in temp) {
				await instance.setItem(key, temp[key])
			}
		}
	}

	return {
		set,
		get,
		unset,
		clear,
		dump,
		restore,
	}
}
