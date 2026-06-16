import { parse as bytesParse } from 'bytes-iec'
import { SyncMode } from '~/settings'
import { isSameTime } from '~/utils/is-same-time'
import logger from '~/utils/logger'
import remotePathToAbsolute from '~/utils/remote-path-to-absolute'
import { remotePathToLocalPath } from '~/utils/remote-path-to-local-path'
import { SkipReason } from '../tasks/skipped.task'
import { BaseTask } from '../tasks/task.interface'
import {
	getIgnoredPathsInFolder,
	hasIgnoredInFolder,
} from '../utils/has-ignored-in-folder'
import BaseSyncDecider from './base.decider'
import { SyncDecisionInput } from './sync-decision.interface'

export default class RemoteMirrorSyncDecider extends BaseSyncDecider {
	async decide(): Promise<BaseTask[]> {
		const input = await this.buildDecisionInput()
		return remoteMirrorDecider(input)
	}
}

/**
 * Remote is the source of truth. Local converges to remote.
 * - remote deleted, local exists → RemoveLocal
 * - remote exists, local deleted → Pull (restore local)
 * - both exist, remote newer → Pull
 * Forbidden: Push, RemoveRemote, MkdirRemote, ConflictResolve
 */
export async function remoteMirrorDecider(
	input: SyncDecisionInput,
): Promise<BaseTask[]> {
	const {
		settings,
		localStats,
		remoteStats,
		syncRecords,
		remoteBaseDir,
		taskFactory,
	} = input

	let maxFileSize = Infinity
	const maxFileSizeStr = settings.skipLargeFiles.maxSize.trim()
	if (maxFileSizeStr !== '') {
		maxFileSize = bytesParse(maxFileSizeStr, { mode: 'jedec' }) ?? Infinity
	}

	const localStatsFiltered = localStats
		.filter((item) => !item.ignored)
		.map((item) => item.stat)
	const remoteStatsFiltered = remoteStats
		.filter((item) => !item.ignored)
		.map((item) => item.stat)

	const localStatsMap = new Map(
		localStatsFiltered.map((item) => [item.path, item]),
	)
	const remoteStatsMap = new Map(
		remoteStatsFiltered.map((item) => [item.path, item]),
	)
	const mixedPath = new Set([...localStatsMap.keys(), ...remoteStatsMap.keys()])

	const tasks: BaseTask[] = []
	const removeLocalFolderTasks: BaseTask[] = []
	const mkdirLocalTasks: BaseTask[] = []

	// * sync files
	for (const p of mixedPath) {
		const remote = remoteStatsMap.get(p)
		const local = localStatsMap.get(p)
		const options = {
			remotePath: p,
			localPath: p,
			remoteBaseDir,
		}
		if (local?.isDir || remote?.isDir) {
			continue
		}

		if (local && remote) {
			// Only loose mode may treat equal-size files as unchanged without further checks.
			if (
				settings.syncMode === SyncMode.LOOSE &&
				!remote.isDeleted &&
				!remote.isDir &&
				remote.size === local.size
			) {
				continue
			}
			const remoteChanged = !isSameTime(remote.mtime, local.mtime)
			if (remoteChanged) {
				logger.debug({
					reason: 'remote-mirror: both exist, remote differs from local',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				if (remote.size > maxFileSize || local.size > maxFileSize) {
					tasks.push(
						taskFactory.createSkippedTask({
							...options,
							reason: SkipReason.FileTooLarge,
							maxSize: maxFileSize,
							remoteSize: remote.size,
							localSize: local.size,
						}),
					)
					continue
				}
				tasks.push(
					taskFactory.createPullTask({
						...options,
						remoteSize: remote.size,
						mobileAppDownloadFileChunkSize:
							settings.mobileAppDownloadFileChunkSize,
					}),
				)
			}
			continue
		}

		if (!local && remote) {
			// Remote exists, local missing → pull to restore/create local
			logger.debug({
				reason: 'remote-mirror: remote exists, local missing — pull',
				localPath: p,
				remotePath: remotePathToAbsolute(remoteBaseDir, p),
			})
			if (remote.size > maxFileSize) {
				tasks.push(
					taskFactory.createSkippedTask({
						...options,
						reason: SkipReason.FileTooLarge,
						maxSize: maxFileSize,
						remoteSize: remote.size,
					}),
				)
				continue
			}
			tasks.push(
				taskFactory.createPullTask({
					...options,
					remoteSize: remote.size,
					mobileAppDownloadFileChunkSize:
						settings.mobileAppDownloadFileChunkSize,
				}),
			)
			continue
		}

		if (local && !remote) {
			// Local exists, remote missing → remove local
			logger.debug({
				reason: 'remote-mirror: local exists, remote missing — remove local',
				localPath: p,
				remotePath: remotePathToAbsolute(remoteBaseDir, p),
			})
			tasks.push(taskFactory.createRemoveLocalTask(options))
			continue
		}
	}

	// * clean orphaned records (both local and remote deleted)
	for (const [recordPath] of syncRecords) {
		const local = localStatsMap.get(recordPath)
		const remote = remoteStatsMap.get(recordPath)
		if (!local && !remote) {
			tasks.push(
				taskFactory.createCleanRecordTask({
					remotePath: recordPath,
					localPath: recordPath,
					remoteBaseDir,
				}),
			)
		}
	}

	// * sync folders: remote -> local (remote-mirror: create local folders for remote ones)
	for (const remote of remoteStatsFiltered) {
		if (!remote.isDir) {
			continue
		}
		const localPath = remotePathToLocalPath(remoteBaseDir, remote.path)
		const local = localStatsMap.get(localPath)

		if (local) {
			if (!local.isDir) {
				throw new Error(
					`Folder conflict: remote path ${remote.path} is a folder but local path ${localPath} is a file`,
				)
			}
		} else {
			logger.debug({
				reason: 'remote-mirror: remote folder missing locally — mkdir local',
				remotePath: remotePathToAbsolute(remoteBaseDir, remote.path),
				localPath,
			})
			mkdirLocalTasks.push(
				taskFactory.createMkdirLocalTask({
					localPath,
					remotePath: remote.path,
					remoteBaseDir,
				}),
			)
		}
	}

	// * sync folders: local -> remote (remote-mirror: remove local folders not in remote)
	for (const local of localStatsFiltered) {
		if (!local.isDir) {
			continue
		}
		const remote = remoteStatsMap.get(local.path)

		if (!remote) {
			if (hasIgnoredInFolder(local.path, localStats)) {
				const ignoredPaths = getIgnoredPathsInFolder(local.path, localStats)
				logger.debug({
					reason:
						'remote-mirror: skip removing local folder (contains ignored items)',
					localPath: local.path,
					ignoredPaths,
				})
				tasks.push(
					taskFactory.createSkippedTask({
						localPath: local.path,
						remotePath: local.path,
						remoteBaseDir,
						reason: SkipReason.FolderContainsIgnoredItems,
						ignoredPaths,
					}),
				)
				continue
			}
			logger.debug({
				reason: 'remote-mirror: local folder missing remotely — remove local',
				localPath: local.path,
				remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
			})
			removeLocalFolderTasks.push(
				taskFactory.createRemoveLocalTask({
					localPath: local.path,
					remotePath: local.path,
					remoteBaseDir,
				}),
			)
		} else {
			if (!remote.isDir) {
				throw new Error(
					`Folder conflict: local path ${local.path} is a folder but remote path ${remote.path} is a file`,
				)
			}
		}
	}

	removeLocalFolderTasks.sort((a, b) => b.localPath.length - a.localPath.length)
	const allFolderTasks = [...removeLocalFolderTasks, ...mkdirLocalTasks]

	tasks.splice(0, 0, ...allFolderTasks)

	return tasks
}
