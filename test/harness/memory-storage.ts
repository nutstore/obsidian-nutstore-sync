import 'fake-indexeddb/auto'
import {
	blobKV,
	cacheUploadMetaKV,
	chatMetaKV,
	chatSessionKV,
	syncRecordKV,
	traverseWebDAVKV,
} from '~/storage'

/**
 * Resets all `localforage` IndexedDB stores used by sync & chat persistence so
 * each simulation run starts from a hermetically isolated database state.
 */
export async function clearAllPluginStorage(): Promise<void> {
	await Promise.all([
		syncRecordKV.clear(),
		blobKV.clear(),
		traverseWebDAVKV.clear(),
		cacheUploadMetaKV.clear(),
		chatSessionKV.clear(),
		chatMetaKV.clear(),
	])
}
