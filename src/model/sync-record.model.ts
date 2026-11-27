import { StatModel } from './stat.model'

/** Maximum file size hashed in mobile WebViews where `readBinary` buffers whole files. */
export const MAX_MOBILE_HASH_BYTES = 20 * 1024 * 1024

/** Maximum file size hashed on desktop to avoid buffering gigabyte attachments in memory. */
export const MAX_DESKTOP_HASH_BYTES = 100 * 1024 * 1024

/** Files at or above this size are hashed one at a time so batch updates do not spike memory. */
export const LARGE_HASH_SERIALIZE_BYTES = 2 * 1024 * 1024

export function getMaxHashBytes(isMobile: boolean): number {
	return isMobile ? MAX_MOBILE_HASH_BYTES : MAX_DESKTOP_HASH_BYTES
}

export interface SyncRecordModel {
	local: StatModel
	remote: StatModel
	base?: {
		key: string
	}
	/** SHA-256 base64 digest of file bytes, stored for both text and binary files. */
	contentHash?: string
}

/** Resolves the recorded content digest, falling back to `base.key` for legacy text records. */
export function getRecordContentHash(
	record: Pick<SyncRecordModel, 'contentHash' | 'base'>,
): string | undefined {
	return record.contentHash ?? record.base?.key
}
