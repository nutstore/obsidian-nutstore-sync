export abstract class StorageInterface<T = any> {
	abstract setItem(key: string, value: T): Promise<T>
	abstract getItem(key: string): Promise<T | null>
	abstract removeItem(key: string): Promise<void>
	abstract keys(): Promise<string[]>
	abstract clear(): Promise<void>
}

export interface RecoverableStorageConfig<T = any> {
	getFreshInstance: () => StorageInterface<T>
	shouldRecover?: (error: unknown) => boolean
	maxRetries?: number
}

const INDEXED_DB_CONNECTION_LOST_PATTERNS = [
	/connection to indexeddb server lost/i,
	/connection to indexeddatabase server lost/i,
	/internal error opening backing store/i,
	/the database connection is closing/i,
]

export function isIndexedDbConnectionLostError(error: unknown): boolean {
	if (!error) {
		return false
	}
	const maybeError = error as { name?: unknown; message?: unknown }
	const name = typeof maybeError.name === 'string' ? maybeError.name : ''
	const message =
		typeof maybeError.message === 'string'
			? maybeError.message
			: typeof error === 'string'
				? error
				: ''
	const text = `${name} ${message}`.trim()
	if (!text) {
		return false
	}
	return INDEXED_DB_CONNECTION_LOST_PATTERNS.some((pattern) =>
		pattern.test(text),
	)
}

function isRecoverableStorageConfig<T = any>(
	value: StorageInterface<T> | RecoverableStorageConfig<T>,
): value is RecoverableStorageConfig<T> {
	return (
		typeof value === 'object' &&
		value !== null &&
		'getFreshInstance' in value &&
		typeof value.getFreshInstance === 'function'
	)
}

export type UseStorageType<T = any> = ReturnType<typeof useStorage<T>>

export default function useStorage<T = any>(
	input: StorageInterface<T> | RecoverableStorageConfig<T>,
) {
	const config = isRecoverableStorageConfig(input)
		? input
		: {
				getFreshInstance: () => input,
				maxRetries: 0,
			}

	let instance = config.getFreshInstance()
	const shouldRecover = config.shouldRecover ?? isIndexedDbConnectionLostError
	const maxRetries = Math.max(0, config.maxRetries ?? 0)

	async function runWithRecovery<R>(
		op: (active: StorageInterface<T>) => Promise<R>,
	): Promise<R> {
		let firstError: unknown
		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				return await op(instance)
			} catch (error) {
				if (attempt === 0) {
					firstError = error
				}
				const canRetry = attempt < maxRetries && shouldRecover(error)
				if (!canRetry) {
					throw firstError ?? error
				}
				instance = config.getFreshInstance()
			}
		}
		throw new Error('Unexpected storage retry state')
	}

	function set(key: string, value: T) {
		return runWithRecovery((active) => active.setItem(key, value))
	}

	function get(key: string) {
		return runWithRecovery((active) => active.getItem(key))
	}

	function unset(key: string) {
		return runWithRecovery((active) => active.removeItem(key))
	}

	function clear() {
		return runWithRecovery((active) => active.clear())
	}

	async function dump() {
		const keys = await runWithRecovery((active) => active.keys())
		const data: Record<string, T> = {}
		for (const key of keys) {
			const val = await runWithRecovery((active) => active.getItem(key))
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
			await clear()
			for (const key in data) {
				await set(key, data[key])
			}
		} catch {
			await clear()
			for (const key in temp) {
				await set(key, temp[key])
			}
		}
	}

	async function keys() {
		return await runWithRecovery((active) => active.keys())
	}

	return {
		set,
		get,
		unset,
		clear,
		dump,
		restore,
		keys,
	}
}
