import type { FsWalkResult } from '~/fs/fs.interface'

/** Collects every observed path (including ignored entries) for O(1) lookup. */
export function collectWalkPaths(
	entries: readonly FsWalkResult[],
): Set<string> {
	const paths = new Set<string>()
	for (const item of entries) {
		paths.add(item.stat.path)
	}
	return paths
}

function isWalkResultList(
	stats: readonly FsWalkResult[] | ReadonlySet<string>,
): stats is readonly FsWalkResult[] {
	return Array.isArray(stats)
}

function containsRecordPath(
	stats: readonly FsWalkResult[] | ReadonlySet<string>,
	recordPath: string,
): boolean {
	if (isWalkResultList(stats)) {
		return stats.some((item) => item.stat.path === recordPath)
	}
	return stats.has(recordPath)
}

/**
 * A record is orphaned only when neither complete walk contains its path.
 * Ignored entries still prove existence: filtering controls synchronization,
 * not deletion of the history needed if the path becomes included again.
 */
export function shouldCreateCleanRecordTask(
	recordPath: string,
	localStats: readonly FsWalkResult[] | ReadonlySet<string>,
	remoteStats: readonly FsWalkResult[] | ReadonlySet<string>,
): boolean {
	return (
		!containsRecordPath(localStats, recordPath) &&
		!containsRecordPath(remoteStats, recordPath)
	)
}
