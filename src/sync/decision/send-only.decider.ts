import { parse as bytesParse } from 'bytes-iec'
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
import { hasFolderContentChanged } from '../core/has-folder-content-changed'
import BaseSyncDecider from './base.decider'
import { areLooseEqualFiles } from './loose-equality'
import { SyncDecisionInput } from './sync-decision.interface'

export default class SendOnlySyncDecider extends BaseSyncDecider {
	async decide(): Promise<BaseTask[]> {
		const input = await this.buildDecisionInput()
		return sendOnlyDecider(input, { overrideChanges: false })
	}
}

export class SendOnlyOverrideChangesSyncDecider extends BaseSyncDecider {
	async decide(): Promise<BaseTask[]> {
		const input = await this.buildDecisionInput()
		return sendOnlyDecider(input, { overrideChanges: true })
	}
}

/**
 * Local is the source of truth for paths that exist locally.
 * - local exists, remote missing → Push
 * - both exist, local differs → Push
 * - recorded remote-only paths are removed when remote is unchanged; otherwise preserved
 * - unrecorded remote-only paths are preserved unless overrideChanges is enabled
 * Forbidden: Pull, RemoveLocal, MkdirLocal, ConflictResolve
 */
export async function sendOnlyDecider(
	input: SyncDecisionInput,
	mode: { overrideChanges: boolean },
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

	const pushLocalFile = (
		p: string,
		localSize: number,
		remoteSize?: number,
	): boolean => {
		const taskOptions = {
			remotePath: p,
			localPath: p,
			remoteBaseDir,
		}
		if (
			localSize > maxFileSize ||
			(remoteSize !== undefined && remoteSize > maxFileSize)
		) {
			tasks.push(
				taskFactory.createSkippedTask({
					...taskOptions,
					reason: SkipReason.FileTooLarge,
					maxSize: maxFileSize,
					localSize,
					...(remoteSize === undefined ? {} : { remoteSize }),
				}),
			)
			return false
		}
		if (hasInvalidChar(p)) {
			tasks.push(taskFactory.createFilenameErrorTask(taskOptions))
			return false
		}
		tasks.push(taskFactory.createPushTask(taskOptions))
		return true
	}

	// * sync files
	for (const p of mixedPath) {
		const remote = remoteStatsMap.get(p)
		const local = localStatsMap.get(p)
		const record = syncRecords.get(p)
		const taskOptions = {
			remotePath: p,
			localPath: p,
			remoteBaseDir,
		}
		if (local?.isDir || remote?.isDir) {
			continue
		}

		if (local && remote) {
			// In loose mode, same-path same-type same-size files are considered equal.
			if (!record && areLooseEqualFiles(settings.syncMode, local, remote)) {
				tasks.push(taskFactory.createNoopTask(taskOptions))
				continue
			}
			if (!record) {
				logger.debug({
					reason: 'send-only: both exist without record — push from local',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				pushLocalFile(p, local.size, remote.size)
				continue
			}
			const localChanged = !isSameTime(local.mtime, record.local.mtime)
			const remoteChanged = !isSameTime(remote.mtime, record.remote.mtime)
			const shouldPush = mode.overrideChanges
				? localChanged || remoteChanged
				: localChanged && !remoteChanged
			if (shouldPush) {
				logger.debug({
					reason: 'send-only: both exist, source state changed',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				pushLocalFile(p, local.size, remote.size)
			} else if (localChanged && remoteChanged && !mode.overrideChanges) {
				logger.debug({
					reason: 'send-only: both local and remote changed — skip',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				tasks.push(
					taskFactory.createSkippedTask({
						...taskOptions,
						reason: SkipReason.ConflictInSendOnlyMode,
					}),
				)
			} else if (remoteChanged && !mode.overrideChanges) {
				logger.debug({
					reason: 'send-only: preserve remote-side change until override',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
			}
			continue
		}

		if (local && !remote) {
			if (record && !mode.overrideChanges) {
				logger.debug({
					reason: 'send-only: preserve remote deletion until override',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				continue
			}
			// Local exists, remote missing → push to restore/create remote
			logger.debug({
				reason: 'send-only: local exists, remote missing — push',
				localPath: p,
				remotePath: remotePathToAbsolute(remoteBaseDir, p),
			})
			pushLocalFile(p, local.size)
			continue
		}

		if (!local && remote) {
			if (mode.overrideChanges) {
				logger.debug({
					reason:
						'send-only override: remote exists, local missing — remove remote',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				tasks.push(taskFactory.createRemoveRemoteTask(taskOptions))
				continue
			}
			if (!record) {
				logger.debug({
					reason: 'send-only: remote-only without record — preserve remote',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				continue
			}
			const remoteChanged = !isSameTime(remote.mtime, record.remote.mtime)
			if (!remoteChanged) {
				logger.debug({
					reason: 'send-only: local deleted, remote unchanged — remove remote',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				tasks.push(taskFactory.createRemoveRemoteTask(taskOptions))
			} else {
				logger.debug({
					reason:
						'send-only: local deleted, remote changed — skip to protect remote change',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				tasks.push(
					taskFactory.createSkippedTask({
						...taskOptions,
						reason: SkipReason.DeletedLocallyButChangedRemotely,
					}),
				)
			}
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

	// * sync folders: remote -> local (override only removes remote folders not in local)
	for (const remote of remoteStatsFiltered) {
		if (!remote.isDir) {
			continue
		}
		const localPath = remotePathToLocalPath(remoteBaseDir, remote.path)
		const local = localStatsMap.get(localPath)

		if (local) {
			if (!local.isDir) {
				if (mode.overrideChanges) {
					if (hasIgnoredInFolder(remote.path, remoteStats)) {
						const ignoredPaths = getIgnoredPathsInFolder(
							remote.path,
							remoteStats,
						)
						logger.debug({
							reason:
								'send-only override: skip replacing remote folder with local file (contains ignored items)',
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
						reason: 'send-only override: replace remote folder with local file',
						remotePath: remotePathToAbsolute(remoteBaseDir, remote.path),
						localPath,
					})
					if (pushLocalFile(localPath, local.size)) {
						removeRemoteFolderTasks.push(
							taskFactory.createRemoveRemoteTask({
								localPath: remote.path,
								remotePath: remote.path,
								remoteBaseDir,
							}),
						)
					}
					continue
				}
				throw new Error(
					`Folder conflict: remote path ${remote.path} is a folder but local path ${localPath} is a file`,
				)
			}
		} else {
			if (mode.overrideChanges) {
				if (hasIgnoredInFolder(remote.path, remoteStats)) {
					const ignoredPaths = getIgnoredPathsInFolder(remote.path, remoteStats)
					logger.debug({
						reason:
							'send-only override: skip removing remote folder (contains ignored items)',
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
					reason:
						'send-only override: remote folder missing locally — remove remote',
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
				continue
			}
			const folderRecord = syncRecords.get(localPath)
			if (!folderRecord) {
				logger.debug({
					reason:
						'send-only: remote folder missing locally without record — preserve remote',
					remotePath: remotePathToAbsolute(remoteBaseDir, remote.path),
					localPath,
				})
				continue
			}
			const remoteFolderChanged = hasFolderContentChanged(
				remote.path,
				remoteStatsFiltered,
				syncRecords,
				'remote',
			)
			if (!remoteFolderChanged) {
				if (hasIgnoredInFolder(remote.path, remoteStats)) {
					const ignoredPaths = getIgnoredPathsInFolder(remote.path, remoteStats)
					logger.debug({
						reason:
							'send-only: skip removing remote folder (contains ignored items)',
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
					reason:
						'send-only: local folder deleted, remote folder unchanged — remove remote',
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
			} else {
				logger.debug({
					reason:
						'send-only: local folder deleted, remote folder changed — skip to protect remote change',
					remotePath: remotePathToAbsolute(remoteBaseDir, remote.path),
					localPath,
				})
				tasks.push(
					taskFactory.createSkippedTask({
						localPath,
						remotePath: remote.path,
						remoteBaseDir,
						reason: SkipReason.DeletedLocallyButChangedRemotely,
					}),
				)
			}
		}
	}

	// * sync folders: local -> remote (create remote folders for local ones)
	for (const local of localStatsFiltered) {
		if (!local.isDir) {
			continue
		}
		const remote = remoteStatsMap.get(local.path)

		if (!remote) {
			const folderRecord = syncRecords.get(local.path)
			if (folderRecord && !mode.overrideChanges) {
				logger.debug({
					reason: 'send-only: preserve remote folder deletion until override',
					localPath: local.path,
					remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
				})
				continue
			}
			logger.debug({
				reason: 'send-only: local folder missing remotely — mkdir remote',
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
				if (mode.overrideChanges) {
					logger.debug({
						reason: 'send-only override: replace remote file with local folder',
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
						removeRemoteFolderTasks.push(
							taskFactory.createRemoveRemoteTask({
								localPath: local.path,
								remotePath: local.path,
								remoteBaseDir,
							}),
						)
						mkdirRemoteTasks.push(
							taskFactory.createMkdirRemoteTask({
								localPath: local.path,
								remotePath: local.path,
								remoteBaseDir,
							}),
						)
					}
					continue
				}
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
