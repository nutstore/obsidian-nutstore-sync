import localforage from 'localforage'
import { DeltaResponse } from '~/api/delta'
import { StatModel } from '~/model/stat.model'

const DB_NAME = 'NutStore_Plugin_Cache'

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

function useStorage<T = any>(instance: LocalForage) {
	return {
		set(key: string, value: T) {
			return instance.setItem(key, value)
		},
		get(key: string) {
			return instance.getItem<T>(key)
		},
		clear() {
			return instance.clear()
		},
	}
}
