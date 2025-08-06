export abstract class StorageInterface<T = any> {
	abstract setItem(key: string, value: T): Promise<T>
	abstract getItem(key: string): Promise<T | null>
	abstract removeItem(key: string): Promise<void>
	abstract keys(): Promise<string[]>
	abstract clear(): Promise<void>
}

export type UseStorageType<T = any> = ReturnType<typeof useStorage<T>>

export default function useStorage<T = any>(instance: StorageInterface<T>) {
	function set(key: string, value: T) {
		return instance.setItem(key, value)
	}

	function get(key: string) {
		return instance.getItem(key)
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
			const val = await instance.getItem(key)
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
