import { parse as bytesParse } from 'bytes-iec'
import { SyncMode } from '~/settings'
import { hasInvalidChar } from '~/utils/has-invalid-char'
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

export default class LocalMirrorSyncDecider extends BaseSyncDecider {
	async decide(): Promise<BaseTask[]> {
		const input = await this.buildDecisionInput()
		return localMirrorDecider(input)
	}
}

/**
 * Local is the source of truth. Remote converges to local.
 * - local deleted, remote exists → RemoveRemote
 * - local exists, remote deleted → Push (restore remote)
 * - both exist, local newer → Push
 * Forbidden: Pull, RemoveLocal, MkdirLocal, ConflictResolve
 */
export async function localMirrorDecider(
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
	const removeRemoteFolderTasks: BaseTask[] = []
	const mkdirRemoteTasks: BaseTask[] = []

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
			const localChanged = !isSameTime(local.mtime, remote.mtime)
			if (localChanged) {
				logger.debug({
					reason: 'local-mirror: both exist, local differs from remote',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				if (local.size > maxFileSize || remote.size > maxFileSize) {
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
				if (hasInvalidChar(local.path)) {
					tasks.push(taskFactory.createFilenameErrorTask(options))
				} else {
					tasks.push(taskFactory.createPushTask(options))
				}
			}
			continue
		}

		if (local && !remote) {
			// Local exists, remote missing → push to restore/create remote
			logger.debug({
				reason: 'local-mirror: local exists, remote missing — push',
				localPath: p,
				remotePath: remotePathToAbsolute(remoteBaseDir, p),
			})
			if (local.size > maxFileSize) {
				tasks.push(
					taskFactory.createSkippedTask({
						...options,
						reason: SkipReason.FileTooLarge,
						maxSize: maxFileSize,
						localSize: local.size,
					}),
				)
				continue
			}
			if (hasInvalidChar(local.path)) {
				tasks.push(taskFactory.createFilenameErrorTask(options))
			} else {
				tasks.push(taskFactory.createPushTask(options))
			}
			continue
		}

		if (!local && remote) {
			// Remote exists, local missing → remove remote
			logger.debug({
				reason: 'local-mirror: remote exists, local missing — remove remote',
				localPath: p,
				remotePath: remotePathToAbsolute(remoteBaseDir, p),
			})
			tasks.push(taskFactory.createRemoveRemoteTask(options))
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

	// * sync folders: remote -> local (local-mirror: only remove remote folders not in local)
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
			// Remote folder has no local counterpart → remove it
			if (hasIgnoredInFolder(remote.path, remoteStats)) {
				const ignoredPaths = getIgnoredPathsInFolder(remote.path, remoteStats)
				logger.debug({
					reason:
						'local-mirror: skip removing remote folder (contains ignored items)',
					remotePath: remotePathToAbsolute(remoteBaseDir, remote.path),
					localPath,
					ignoredPaths,
				})
				tasks.push(
					taskFactory.createSkippedTask({
						localPath,
						remotePath: remote.path,
						remoteBaseDir,
						reason: SkipReason.FolderContainsIgnoredItems,
						ignoredPaths,
					}),
				)
				continue
			}
			logger.debug({
				reason: 'local-mirror: remote folder missing locally — remove remote',
				remotePath: remotePathToAbsolute(remoteBaseDir, remote.path),
				localPath,
			})
			removeRemoteFolderTasks.push(
				taskFactory.createRemoveRemoteTask({
					localPath: remote.path,
					remotePath: remote.path,
					remoteBaseDir,
				}),
			)
		}
	}

	// * sync folders: local -> remote (local-mirror: create remote folders for local ones)
	for (const local of localStatsFiltered) {
		if (!local.isDir) {
			continue
		}
		const remote = remoteStatsMap.get(local.path)

		if (!remote) {
			logger.debug({
				reason: 'local-mirror: local folder missing remotely — mkdir remote',
				localPath: local.path,
				remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
			})
			if (hasInvalidChar(local.path)) {
				tasks.push(
					taskFactory.createFilenameErrorTask({
						localPath: local.path,
						remotePath: local.path,
						remoteBaseDir,
					}),
				)
			} else {
				mkdirRemoteTasks.push(
					taskFactory.createMkdirRemoteTask({
						localPath: local.path,
						remotePath: local.path,
						remoteBaseDir,
					}),
				)
			}
		} else {
			if (!remote.isDir) {
				throw new Error(
					`Folder conflict: local path ${local.path} is a folder but remote path ${remote.path} is a file`,
				)
			}
		}
	}

	removeRemoteFolderTasks.sort(
		(a, b) => b.remotePath.length - a.remotePath.length,
	)
	const allFolderTasks = [...removeRemoteFolderTasks, ...mkdirRemoteTasks]

	tasks.splice(0, 0, ...allFolderTasks)

	return tasks
}
