import localforage from 'localforage'
import useStorage from './use-storage'

/** WebKit service failures can surface as AbortError as well as UnknownError.
 * These names permit one recovery attempt; they are not proof of disconnection.
 * Never classify by browser-localized messages or retry quota/serialization errors.
 */
function canRecover(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'name' in error &&
		(error.name === 'UnknownError' ||
			error.name === 'InvalidStateError' ||
			error.name === 'AbortError')
	)
}

export function createIndexedDbStorage<T>(name: string, storeName: string) {
	const instance = localforage.createInstance({ name, storeName })
	return useStorage<T>({
		instance,
		shouldRecover: (error) =>
			instance.driver() === localforage.INDEXEDDB && canRecover(error),
		recover: () => {
			// localforage 1.10 shares this connection across stores. Closing it forces
			// its transaction-level reconnect to reopen the database and update all
			// shared instances on the next call.
			// Keep this private-driver dependency here; integration tests exercise it
			// against the actual library so upgrades cannot silently break recovery.
			const driver = instance as LocalForage & {
				_dbInfo?: { db?: IDBDatabase | null }
			}
			driver._dbInfo?.db?.close()
		},
		maxRetries: 1,
	})
}
