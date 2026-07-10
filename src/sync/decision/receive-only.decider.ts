import { parse as bytesParse } from 'bytes-iec'
import { isPluginSelfPath } from '~/utils/config-dir-rules'
import { isSameTime } from '~/utils/is-same-time'
import remotePathToAbsolute from '~/utils/remote-path-to-absolute'
import { remotePathToLocalPath } from '~/utils/remote-path-to-local-path'
import { hasFolderContentChanged } from '../core/has-folder-content-changed'
import { areLooseEqualFiles } from '../core/loose-equality'
import { shouldCreateCleanRecordTask } from '../core/record-cleanup'
import { SkipReason } from '../tasks/skipped.task'
import { BaseTask } from '../tasks/task.interface'
import {
	getIgnoredPathsInFolder,
	hasIgnoredInFolder,
} from '../utils/has-ignored-in-folder'
import BaseSyncDecider from './base.decider'
import { SyncDecisionInput } from './sync-decision.interface'

export default class ReceiveOnlySyncDecider extends BaseSyncDecider {
	async decide(): Promise<BaseTask[]> {
		const input = await this.buildDecisionInput()
		return receiveOnlyDecider(input, { revertLocalChanges: false })
	}
}

export class ReceiveOnlyRevertLocalChangesSyncDecider extends BaseSyncDecider {
	async decide(): Promise<BaseTask[]> {
		const input = await this.buildDecisionInput()
		return receiveOnlyDecider(input, { revertLocalChanges: true })
	}
}

/**
 * Remote is the source of truth for paths that exist remotely.
 * - remote exists, local missing → Pull
 * - both exist, remote differs → Pull
 * - recorded local-only paths are removed when local is unchanged; otherwise preserved
 * - unrecorded local-only paths are preserved unless revertLocalChanges is enabled
 * Forbidden: Push, RemoveRemote, MkdirRemote, ConflictResolve
 */
export async function receiveOnlyDecider(
	input: SyncDecisionInput,
	mode: { revertLocalChanges: boolean },
): Promise<BaseTask[]> {
	const {
		logger,
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

	const pullRemoteFile = (
		p: string,
		remoteSize: number,
		localSize?: number,
	): boolean => {
		const taskOptions = {
			remotePath: p,
			localPath: p,
			remoteBaseDir,
		}
		if (
			remoteSize > maxFileSize ||
			(localSize !== undefined && localSize > maxFileSize)
		) {
			tasks.push(
				taskFactory.createSkippedTask({
					...taskOptions,
					reason: SkipReason.FileTooLarge,
					maxSize: maxFileSize,
					remoteSize,
					...(localSize === undefined ? {} : { localSize }),
				}),
			)
			return false
		}
		tasks.push(
			taskFactory.createPullTask({
				...taskOptions,
				remoteSize,
				mobileAppDownloadFileChunkSize: settings.mobileAppDownloadFileChunkSize,
			}),
		)
		return true
	}

	const removeLocalFile = (p: string, localSize: number): boolean => {
		const taskOptions = {
			remotePath: p,
			localPath: p,
			remoteBaseDir,
		}
		if (localSize > maxFileSize) {
			tasks.push(
				taskFactory.createSkippedTask({
					...taskOptions,
					reason: SkipReason.FileTooLarge,
					maxSize: maxFileSize,
					localSize,
				}),
			)
			return false
		}
		tasks.push(taskFactory.createRemoveLocalTask(taskOptions))
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
					reason: 'both exist without record — pull from remote',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				pullRemoteFile(p, remote.size, local.size)
				continue
			}
			const remoteChanged = !isSameTime(remote.mtime, record.remote.mtime)
			const localChanged = !isSameTime(local.mtime, record.local.mtime)
			const shouldPull = mode.revertLocalChanges
				? remoteChanged || localChanged
				: remoteChanged && !localChanged
			if (shouldPull) {
				logger.debug({
					reason: 'both exist, source state changed',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				pullRemoteFile(p, remote.size, local.size)
			} else if (localChanged && remoteChanged && !mode.revertLocalChanges) {
				logger.debug({
					reason: 'both local and remote changed — skip',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				tasks.push(
					taskFactory.createSkippedTask({
						...taskOptions,
						reason: SkipReason.ConflictInReceiveOnlyMode,
					}),
				)
			} else if (localChanged && !mode.revertLocalChanges) {
				logger.debug({
					reason: 'preserve local change until revert',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
			}
			continue
		}

		if (!local && remote) {
			if (record && !mode.revertLocalChanges) {
				logger.debug({
					reason: 'preserve local deletion until revert',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				continue
			}
			// Remote exists, local missing → pull to restore/create local
			logger.debug({
				reason: 'remote exists, local missing — pull',
				localPath: p,
				remotePath: remotePathToAbsolute(remoteBaseDir, p),
			})
			pullRemoteFile(p, remote.size)
			continue
		}

		if (local && !remote) {
			// Prevent the plugin from deleting its own files when the remote
			// vault does not have the plugin installed.
			if (isPluginSelfPath(p, settings.configDir)) {
				logger.debug({
					reason: 'plugin self-path missing remotely — preserve local',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				continue
			}
			if (mode.revertLocalChanges) {
				logger.debug({
					reason: 'local exists, remote missing — remove local',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				removeLocalFile(p, local.size)
				continue
			}
			if (!record) {
				logger.debug({
					reason: 'local-only without record — preserve local',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				continue
			}
			const localChanged = !isSameTime(local.mtime, record.local.mtime)
			if (!localChanged) {
				logger.debug({
					reason: 'remote deleted, local unchanged — remove local',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				removeLocalFile(p, local.size)
			} else {
				logger.debug({
					reason:
						'remote deleted, local changed — skip to protect local change',
					localPath: p,
					remotePath: remotePathToAbsolute(remoteBaseDir, p),
				})
				tasks.push(
					taskFactory.createSkippedTask({
						...taskOptions,
						reason: SkipReason.DeletedRemotelyButChangedLocally,
					}),
				)
			}
			continue
		}
	}

	// * clean orphaned records (both local and remote deleted)
	for (const [recordPath] of syncRecords) {
		if (shouldCreateCleanRecordTask(recordPath, localStats, remoteStats)) {
			tasks.push(
				taskFactory.createCleanRecordTask({
					remotePath: recordPath,
					localPath: recordPath,
					remoteBaseDir,
				}),
			)
		}
	}

	// * sync folders: remote -> local (create local folders for remote ones)
	for (const remote of remoteStatsFiltered) {
		if (!remote.isDir) {
			continue
		}
		const localPath = remotePathToLocalPath(remoteBaseDir, remote.path)
		const local = localStatsMap.get(localPath)

		if (local) {
			if (!local.isDir) {
				if (mode.revertLocalChanges) {
					logger.debug({
						reason: 'replace local file with remote folder',
						remotePath: remotePathToAbsolute(remoteBaseDir, remote.path),
						localPath,
					})
					removeLocalFolderTasks.push(
						taskFactory.createRemoveLocalTask({
							localPath,
							remotePath: remote.path,
							remoteBaseDir,
						}),
					)
					mkdirLocalTasks.push(
						taskFactory.createMkdirLocalTask({
							localPath,
							remotePath: remote.path,
							remoteBaseDir,
						}),
					)
					continue
				}
				throw new Error(
					`Folder conflict: remote path ${remote.path} is a folder but local path ${localPath} is a file`,
				)
			}
		} else {
			const folderRecord = syncRecords.get(localPath)
			if (folderRecord && !mode.revertLocalChanges) {
				logger.debug({
					reason: 'preserve local folder deletion until revert',
					remotePath: remotePathToAbsolute(remoteBaseDir, remote.path),
					localPath,
				})
				continue
			}
			logger.debug({
				reason: 'remote folder missing locally — mkdir local',
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

	// * sync folders: local -> remote (revert only removes local folders not in remote)
	for (const local of localStatsFiltered) {
		if (!local.isDir) {
			continue
		}
		const remote = remoteStatsMap.get(local.path)

		if (!remote) {
			// Prevent the plugin from deleting its own folder when the remote
			// vault does not have the plugin installed.
			if (isPluginSelfPath(local.path, settings.configDir)) {
				logger.debug({
					reason: 'plugin self-folder missing remotely — preserve local',
					localPath: local.path,
					remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
				})
				continue
			}
			if (mode.revertLocalChanges) {
				if (hasIgnoredInFolder(local.path, localStats)) {
					const ignoredPaths = getIgnoredPathsInFolder(local.path, localStats)
					logger.debug({
						reason: 'skip removing local folder (contains ignored items)',
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
					reason: 'local folder missing remotely — remove local',
					localPath: local.path,
					remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
				})
				removeLocalFolderTasks.push(
					taskFactory.createRemoveLocalTask({
						localPath: local.path,
						remotePath: local.path,
						remoteBaseDir,
						recursive: true,
					}),
				)
				continue
			}
			const folderRecord = syncRecords.get(local.path)
			if (!folderRecord) {
				logger.debug({
					reason:
						'local folder missing remotely without record — preserve local',
					localPath: local.path,
					remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
				})
				continue
			}
			const localFolderChanged = hasFolderContentChanged(
				local.path,
				localStatsFiltered,
				syncRecords,
				'local',
			)
			if (!localFolderChanged) {
				if (hasIgnoredInFolder(local.path, localStats)) {
					const ignoredPaths = getIgnoredPathsInFolder(local.path, localStats)
					logger.debug({
						reason: 'skip removing local folder (contains ignored items)',
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
					reason:
						'remote folder deleted, local folder unchanged — remove local',
					localPath: local.path,
					remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
				})
				removeLocalFolderTasks.push(
					taskFactory.createRemoveLocalTask({
						localPath: local.path,
						remotePath: local.path,
						remoteBaseDir,
						recursive: true,
					}),
				)
			} else {
				logger.debug({
					reason:
						'remote folder deleted, local folder changed — skip to protect local change',
					localPath: local.path,
					remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
				})
				tasks.push(
					taskFactory.createSkippedTask({
						localPath: local.path,
						remotePath: local.path,
						remoteBaseDir,
						reason: SkipReason.DeletedRemotelyButChangedLocally,
					}),
				)
			}
		} else {
			if (!remote.isDir) {
				if (mode.revertLocalChanges) {
					if (hasIgnoredInFolder(local.path, localStats)) {
						const ignoredPaths = getIgnoredPathsInFolder(local.path, localStats)
						logger.debug({
							reason:
								'skip replacing local folder with remote file (contains ignored items)',
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
						reason: 'replace local folder with remote file',
						localPath: local.path,
						remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
					})
					if (pullRemoteFile(local.path, remote.size)) {
						removeLocalFolderTasks.push(
							taskFactory.createRemoveLocalTask({
								localPath: local.path,
								remotePath: local.path,
								remoteBaseDir,
								recursive: true,
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

	removeLocalFolderTasks.sort((a, b) => b.localPath.length - a.localPath.length)
	const allFolderTasks = [...removeLocalFolderTasks, ...mkdirLocalTasks]

	tasks.splice(0, 0, ...allFolderTasks)

	return tasks
}
