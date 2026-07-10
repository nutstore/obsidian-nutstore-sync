import { FsWalkResult } from '~/fs/fs.interface'

export function shouldCreateCleanRecordTask(
	recordPath: string,
	localStats: FsWalkResult[],
	remoteStats: FsWalkResult[],
): boolean {
	const hasVisibleLocal = localStats.some(
		(item) => item.stat.path === recordPath && !item.ignored,
	)
	const hasVisibleRemote = remoteStats.some(
		(item) => item.stat.path === recordPath && !item.ignored,
	)
	if (hasVisibleLocal || hasVisibleRemote) {
		return false
	}

	const hasAnyLocal = localStats.some((item) => item.stat.path === recordPath)
	const hasAnyRemote = remoteStats.some((item) => item.stat.path === recordPath)
	return !hasAnyLocal && !hasAnyRemote
}
