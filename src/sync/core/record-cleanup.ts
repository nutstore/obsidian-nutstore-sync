import type { FsWalkResult } from '~/fs/fs.interface'

/**
 * A record is orphaned only when neither complete walk contains its path.
 * Ignored entries still prove existence: filtering controls synchronization,
 * not deletion of the history needed if the path becomes included again.
 */
export function shouldCreateCleanRecordTask(
	recordPath: string,
	localStats: readonly FsWalkResult[],
	remoteStats: readonly FsWalkResult[],
): boolean {
	return (
		!localStats.some((item) => item.stat.path === recordPath) &&
		!remoteStats.some((item) => item.stat.path === recordPath)
	)
}
