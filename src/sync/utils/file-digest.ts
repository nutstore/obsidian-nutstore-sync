import { Platform } from 'obsidian'
import {
	getMaxHashBytes,
	LARGE_HASH_SERIALIZE_BYTES,
} from '~/model/sync-record.model'
import { blobStore } from '~/storage/blob'
import { isMergeablePath } from '~/sync/utils/is-mergeable-path'
import { AsyncMutex } from '~/utils/async-lock'
import { sha256Base64 } from '~/utils/sha256'

/**
 * Computes the persisted `contentHash` (and conflict-merge `base` blob for
 * mergeable text paths) directly from already-transferred file bytes.
 */
export async function computeBufferDigest(
	buffer: ArrayBuffer,
	localPath: string,
	largeFileHashMutex?: AsyncMutex,
): Promise<{ base?: { key: string }; contentHash?: string }> {
	const storeBase = isMergeablePath(localPath)
	const shouldHash =
		storeBase || buffer.byteLength <= getMaxHashBytes(Platform.isMobile)
	if (!shouldHash) {
		return {}
	}
	const run = async () => {
		if (storeBase) {
			const { key } = await blobStore.store(buffer)
			return { base: { key }, contentHash: key }
		}
		return { contentHash: await sha256Base64(buffer) }
	}
	return largeFileHashMutex && buffer.byteLength >= LARGE_HASH_SERIALIZE_BYTES
		? await largeFileHashMutex.runExclusive(run)
		: await run()
}
