import type { StatModel } from '~/model/stat.model'
import type { SyncRecordModel } from '~/model/sync-record.model'
import { isSub } from '~/utils/is-sub'
import {
	evaluateRemoteFileChange,
	hasFileMetadataChanged,
} from './file-changes'

/**
 * Check if folder content has changed (based on sub-items check, not folder mtime).
 * On the remote side, unverified legacy entries conservatively protect the folder.
 */
export function hasFolderContentChanged(
	folderPath: string,
	stats: readonly StatModel[],
	syncRecords: Map<string, SyncRecordModel>,
	side: 'local' | 'remote',
): boolean {
	for (const sub of stats) {
		if (!isSub(folderPath, sub.path)) {
			continue
		}

		const subRecord = syncRecords.get(sub.path)

		// Case 1: sub-item has no sync record → new content
		if (!subRecord) {
			return true
		}

		// Case 2: sub-item has sync record, check if modified or type-flipped
		if (sub.isDir) {
			const recorded = side === 'remote' ? subRecord.remote : subRecord.local
			if (!recorded.isDir) {
				return true
			}
		} else if (side === 'remote') {
			if (evaluateRemoteFileChange(sub, subRecord.remote) !== 'unchanged') {
				return true
			}
		} else if (hasFileMetadataChanged(sub, subRecord.local)) {
			return true
		}
	}

	return false
}
