import { isSameTime } from '~/utils/is-same-time'
import { isSub } from '~/utils/is-sub'

/**
 * Check if folder content has changed (based on sub-items check, not folder mtime)
 * @param folderPath folder path
 * @param stats file/folder stats list (localStats or remoteStats)
 * @param syncRecords sync records
 * @param side 'local' or 'remote', specifies which side's mtime to check
 * @returns true if changed, false if no changes
 */
export function hasFolderContentChanged(
	folderPath: string,
	stats: Array<{ path: string; mtime?: number; isDir: boolean }>,
	syncRecords: Map<string, any>,
	side: 'local' | 'remote',
): boolean {
	for (const sub of stats) {
		// Only check sub-items under this folder
		if (!isSub(folderPath, sub.path)) {
			continue
		}

		const subRecord = syncRecords.get(sub.path)

		// Case 1: sub-item has no sync record → new content
		if (!subRecord) {
			return true
		}

		// Case 2: sub-item has sync record, check if modified
		// Only check mtime for files, not folders (folder mtime is unreliable)
		if (!sub.isDir) {
			const recordMtime =
				side === 'local' ? subRecord.local.mtime : subRecord.remote.mtime
			if (sub.mtime && recordMtime) {
				if (!isSameTime(sub.mtime, recordMtime)) {
					return true // file modified
				}
			}
		}
	}

	return false // all sub-items unchanged
}
