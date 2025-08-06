import { parse as bytesParse } from 'bytes-iec'
import { SyncMode } from '~/settings'
import { blobStore } from '~/storage/blob'
import { hasInvalidChar } from '~/utils/has-invalid-char'
import { isSameTime } from '~/utils/is-same-time'
import { isSub } from '~/utils/is-sub'
import logger from '~/utils/logger'
import remotePathToAbsolute from '~/utils/remote-path-to-absolute'
import { remotePathToLocalPath } from '~/utils/remote-path-to-local-path'
import { ConflictStrategy } from '../tasks/conflict-resolve.task'
import { BaseTask } from '../tasks/task.interface'
import { SyncDecisionInput } from './sync-decision.interface'

export async function twoWayDecider(
	input: SyncDecisionInput,
): Promise<BaseTask[]> {
	const {
		settings,
		localStats,
		remoteStats,
		syncRecords,
		remoteBaseDir,
		compareFileContent,
		taskFactory,
	} = input

	let maxFileSize = Infinity
	const maxFileSizeStr = settings.skipLargeFiles.maxSize.trim()
	if (maxFileSizeStr !== '') {
		maxFileSize = bytesParse(maxFileSizeStr) ?? Infinity
	}

	const localStatsMap = new Map(localStats.map((item) => [item.path, item]))
	const remoteStatsMap = new Map(remoteStats.map((item) => [item.path, item]))
	const mixedPath = new Set([...localStatsMap.keys(), ...remoteStatsMap.keys()])

	logger.debug(
		'local Stats',
		localStats.map((d) => ({
			path: d.path,
			size: d.isDir ? undefined : d.size,
			isDir: d.isDir,
		})),
	)
	logger.debug(
		'remote Stats',
		remoteStats.map((d) => ({
			path: d.path,
			size: d.isDir ? undefined : d.size,
			isDir: d.isDir,
		})),
	)

	const tasks: BaseTask[] = []
	const removeRemoteFolderTasks: BaseTask[] = []
	const removeLocalFolderTasks: BaseTask[] = []
	const mkdirLocalTasks: BaseTask[] = []
	const mkdirRemoteTasks: BaseTask[] = []
	const noopFolderTasks: BaseTask[] = []

	// * sync files
	for (const p of mixedPath) {
		const remote = remoteStatsMap.get(p)
		const local = localStatsMap.get(p)
		const record = syncRecords.get(p)
		const options = {
			remotePath: p,
			localPath: p,
			remoteBaseDir,
		}
		if (local?.isDir || remote?.isDir) {
			continue
		}
		if (record) {
			if (remote) {
				const remoteChanged = !isSameTime(remote.mtime, record.remote.mtime)
				if (local) {
					let localChanged = !isSameTime(local.mtime, record.local.mtime)
					if (localChanged && record.base?.key) {
						const blob = await blobStore.get(record.base.key)
						if (blob) {
							const baseContent = await blob.arrayBuffer()
							localChanged = !(await compareFileContent(
								local.path,
								baseContent,
							))
						}
					}
					if (remoteChanged) {
						if (localChanged) {
							logger.debug({
								reason: 'both local and remote files changed',
								remotePath: remotePathToAbsolute(remoteBaseDir, p),
								localPath: p,
								conditions: {
									remoteChanged,
									localChanged,
									recordExists: !!record,
									remoteExists: !!remote,
									localExists: !!local,
								},
							})
							if (remote.size > maxFileSize || local.size > maxFileSize) {
								continue
							}

							if (hasInvalidChar(local.path)) {
								tasks.push(taskFactory.createFilenameErrorTask(options))
							} else {
								tasks.push(
									taskFactory.createConflictResolveTask({
										...options,
										record,
										strategy:
											settings.conflictStrategy === 'latest-timestamp'
												? ConflictStrategy.LatestTimeStamp
												: ConflictStrategy.DiffMatchPatch,
										localStat: local,
										remoteStat: remote,
										useGitStyle: settings.useGitStyle,
									}),
								)
							}

							continue
						} else {
							logger.debug({
								reason: 'remote file changed',
								remotePath: remotePathToAbsolute(remoteBaseDir, p),
								localPath: p,
								conditions: {
									remoteChanged,
									recordExists: !!record,
									remoteExists: !!remote,
									localExists: !!local,
								},
							})
							if (remote.size > maxFileSize) {
								continue
							}
							tasks.push(taskFactory.createPullTask(options))
							continue
						}
					} else {
						if (localChanged) {
							logger.debug({
								reason: 'local file changed',
								remotePath: remotePathToAbsolute(remoteBaseDir, p),
								localPath: p,
								conditions: {
									localChanged,
									recordExists: !!record,
									remoteExists: !!remote,
									localExists: !!local,
								},
							})
							if (local.size > maxFileSize) {
								continue
							}
							if (hasInvalidChar(local.path)) {
								tasks.push(taskFactory.createFilenameErrorTask(options))
							} else {
								tasks.push(taskFactory.createPushTask(options))
							}
							continue
						}
					}
				} else {
					if (remoteChanged) {
						logger.debug({
							reason: 'remote file changed and local file does not exist',
							remotePath: remotePathToAbsolute(remoteBaseDir, p),
							localPath: p,
							conditions: {
								remoteChanged,
								recordExists: !!record,
								remoteExists: !!remote,
								localExists: !!local,
							},
						})
						if (remote.size > maxFileSize) {
							continue
						}
						tasks.push(taskFactory.createPullTask(options))
						continue
					} else {
						logger.debug({
							reason: 'remote file is removable',
							remotePath: remotePathToAbsolute(remoteBaseDir, p),
							localPath: p,
							conditions: {
								recordExists: !!record,
								remoteExists: !!remote,
								localExists: !!local,
							},
						})
						tasks.push(taskFactory.createRemoveRemoteTask(options))
						continue
					}
				}
			} else if (local) {
				const localChanged = !isSameTime(local.mtime, record.local.mtime)
				if (localChanged) {
					logger.debug({
						reason: 'local file changed and remote file does not exist',
						remotePath: remotePathToAbsolute(remoteBaseDir, p),
						localPath: p,
						conditions: {
							localChanged,
							recordExists: !!record,
							remoteExists: !!remote,
							localExists: !!local,
						},
					})
					if (local.size > maxFileSize) {
						continue
					}
					if (hasInvalidChar(local.path)) {
						tasks.push(taskFactory.createFilenameErrorTask(options))
					} else {
						tasks.push(taskFactory.createPushTask(options))
					}
					continue
				} else {
					logger.debug({
						reason: 'local file is removable',
						remotePath: remotePathToAbsolute(remoteBaseDir, p),
						localPath: p,
						conditions: {
							recordExists: !!record,
							remoteExists: !!remote,
							localExists: !!local,
						},
					})
					tasks.push(taskFactory.createRemoveLocalTask(options))
					continue
				}
			}
		} else {
			if (remote) {
				if (local) {
					if (
						settings.syncMode === SyncMode.LOOSE &&
						!remote.isDeleted &&
						!remote.isDir &&
						remote.size === local.size
					) {
						tasks.push(
							taskFactory.createNoopTask({
								...options,
							}),
						)
						continue
					}
					logger.debug({
						reason: 'both local and remote files exist without a record',
						remotePath: remotePathToAbsolute(remoteBaseDir, p),
						localPath: p,
						conditions: {
							recordExists: !!record,
							remoteExists: !!remote,
							localExists: !!local,
						},
					})

					if (remote.size > maxFileSize || local.size > maxFileSize) {
						continue
					}

					if (hasInvalidChar(local.path)) {
						tasks.push(taskFactory.createFilenameErrorTask(options))
					} else {
						tasks.push(
							taskFactory.createConflictResolveTask({
								...options,
								strategy: ConflictStrategy.DiffMatchPatch,
								localStat: local,
								remoteStat: remote,
								useGitStyle: settings.useGitStyle,
							}),
						)
					}

					continue
				} else {
					logger.debug({
						reason: 'remote file exists without a local file',
						remotePath: remotePathToAbsolute(remoteBaseDir, p),
						localPath: p,
						conditions: {
							recordExists: !!record,
							remoteExists: !!remote,
							localExists: !!local,
						},
					})

					if (remote.size > maxFileSize) {
						continue
					}
					tasks.push(taskFactory.createPullTask(options))
					continue
				}
			} else {
				if (local) {
					logger.debug({
						reason: 'local file exists without a remote file',
						remotePath: remotePathToAbsolute(remoteBaseDir, p),
						localPath: p,
						conditions: {
							recordExists: !!record,
							remoteExists: !!remote,
							localExists: !!local,
						},
					})

					if (local.size > maxFileSize) {
						continue
					}
					if (hasInvalidChar(local.path)) {
						tasks.push(taskFactory.createFilenameErrorTask(options))
					} else {
						tasks.push(taskFactory.createPushTask(options))
					}
					continue
				}
			}
		}
	}

	// * clean orphaned records (both local and remote deleted)
	for (const [recordPath, record] of syncRecords) {
		const local = localStatsMap.get(recordPath)
		const remote = remoteStatsMap.get(recordPath)

		// If both local and remote don't exist, but record exists, clean the record
		if (!local && !remote) {
			logger.debug({
				reason: 'cleaning orphaned sync record (both local and remote deleted)',
				remotePath: remotePathToAbsolute(remoteBaseDir, recordPath),
				localPath: recordPath,
				conditions: {
					localExists: !!local,
					remoteExists: !!remote,
					recordExists: !!record,
				},
			})

			tasks.push(
				taskFactory.createCleanRecordTask({
					remotePath: recordPath,
					localPath: recordPath,
					remoteBaseDir,
				}),
			)
		}
	}

	// * sync folder: remote -> local
	for (const remote of remoteStats) {
		if (!remote.isDir) {
			continue
		}
		const localPath = remotePathToLocalPath(remoteBaseDir, remote.path)
		const local = localStatsMap.get(localPath)
		const record = syncRecords.get(localPath)
		if (local) {
			if (!local.isDir) {
				throw new Error(
					`Folder conflict: remote path ${remote.path} is a folder but local path ${localPath} is a file`,
				)
			}
			if (!record) {
				noopFolderTasks.push(
					taskFactory.createNoopTask({
						localPath: localPath,
						remotePath: remote.path,
						remoteBaseDir,
					}),
				)
				continue
			}
		} else if (record) {
			const remoteChanged =
				remote.mtime && record.remote.mtime
					? !isSameTime(remote.mtime, record.remote.mtime)
					: false
			if (remoteChanged) {
				logger.debug({
					reason: 'remote folder changed',
					remotePath: remotePathToAbsolute(remoteBaseDir, remote.path),
					localPath: localPath,
					conditions: {
						remoteChanged,
						localExists: !!local,
						recordExists: !!record,
					},
				})

				if (hasInvalidChar(localPath)) {
					tasks.push(
						taskFactory.createFilenameErrorTask({
							localPath,
							remotePath: remote.path,
							remoteBaseDir,
						}),
					)
				} else {
					mkdirLocalTasks.push(
						taskFactory.createMkdirLocalTask({
							localPath,
							remotePath: remote.path,
							remoteBaseDir,
						}),
					)
				}

				continue
			}
			// If there are no modified files in the remote folder or no paths that aren't in syncRecord, then the entire folder can be deleted!
			let removable = true
			for (const sub of remoteStats) {
				if (!isSub(remote.path, sub.path)) {
					continue
				}
				const subRecord = syncRecords.get(sub.path)
				if (
					!subRecord ||
					(sub.mtime &&
						subRecord.remote.mtime &&
						!isSameTime(sub.mtime, subRecord.remote.mtime))
				) {
					removable = false
					break
				}
			}
			if (removable) {
				logger.debug({
					reason: 'remote folder is removable',
					remotePath: remotePathToAbsolute(remoteBaseDir, remote.path),
					localPath: localPath,
					conditions: {
						removable,
						localExists: !!local,
						recordExists: !!record,
					},
				})
				removeRemoteFolderTasks.push(
					taskFactory.createRemoveRemoteTask({
						localPath: remote.path,
						remotePath: remote.path,
						remoteBaseDir,
					}),
				)
			}
		} else {
			logger.debug({
				reason: 'remote folder does not exist locally',
				remotePath: remotePathToAbsolute(remoteBaseDir, remote.path),
				localPath: localPath,
				conditions: {
					localExists: !!local,
					recordExists: !!record,
				},
			})

			if (hasInvalidChar(localPath)) {
				tasks.push(
					taskFactory.createFilenameErrorTask({
						localPath,
						remotePath: remote.path,
						remoteBaseDir,
					}),
				)
			} else {
				mkdirLocalTasks.push(
					taskFactory.createMkdirLocalTask({
						localPath,
						remotePath: remote.path,
						remoteBaseDir,
					}),
				)
			}

			continue
		}
	}

	// * sync folder: local -> remote
	for (const local of localStats) {
		if (!local.isDir) {
			continue
		}
		const remote = remoteStatsMap.get(local.path)
		const record = syncRecords.get(local.path)
		if (remote) {
			if (!record) {
				noopFolderTasks.push(
					taskFactory.createNoopTask({
						localPath: local.path,
						remotePath: remote.path,
						remoteBaseDir,
					}),
				)
				continue
			}
		} else {
			if (record) {
				const localChanged = !isSameTime(local.mtime, record.local.mtime)
				if (localChanged) {
					logger.debug({
						reason: 'local folder changed',
						remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
						localPath: local.path,
						conditions: {
							localChanged,
							remoteExists: !!remote,
							recordExists: !!record,
						},
					})
					mkdirRemoteTasks.push(
						taskFactory.createMkdirRemoteTask({
							localPath: local.path,
							remotePath: local.path,
							remoteBaseDir,
						}),
					)
					continue
				}
				// The folder existed remotely before but now it's gone. If there are no modifications in this local folder, then the local folder should be deleted too!
				let removable = true
				for (const sub of localStats) {
					if (!isSub(local.path, sub.path)) {
						continue
					}
					const subRecord = syncRecords.get(sub.path)
					if (
						!subRecord ||
						(sub.mtime &&
							subRecord.local.mtime &&
							!isSameTime(sub.mtime, subRecord.local.mtime))
					) {
						removable = false
						break
					}
				}
				if (removable) {
					logger.debug({
						reason: 'local folder is removable',
						remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
						localPath: local.path,
						conditions: {
							removable,
							remoteExists: !!remote,
							recordExists: !!record,
						},
					})
					removeLocalFolderTasks.push(
						taskFactory.createRemoveLocalTask({
							localPath: local.path,
							remotePath: local.path,
							remoteBaseDir,
						}),
					)
				}
			} else {
				logger.debug({
					reason: 'local folder does not exist remotely',
					remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
					localPath: local.path,
					conditions: {
						remoteExists: !!remote,
						recordExists: !!record,
					},
				})
				mkdirRemoteTasks.push(
					taskFactory.createMkdirRemoteTask({
						localPath: local.path,
						remotePath: local.path,
						remoteBaseDir,
					}),
				)
				continue
			}
			continue
		}
		if (!remote.isDir) {
			throw new Error(
				`Folder conflict: local path ${local.path} is a folder but remote path ${remote.path} is a file`,
			)
		}
	}

	// 排序文件夹任务，确保按正确顺序执行
	removeRemoteFolderTasks.sort(
		(a, b) => b.remotePath.length - a.remotePath.length,
	)
	removeLocalFolderTasks.sort((a, b) => b.localPath.length - a.localPath.length)
	const allFolderTasks = [
		...removeRemoteFolderTasks,
		...removeLocalFolderTasks,
		...mkdirLocalTasks,
		...mkdirRemoteTasks,
		...noopFolderTasks,
	]

	tasks.splice(0, 0, ...allFolderTasks)
	return tasks
}
