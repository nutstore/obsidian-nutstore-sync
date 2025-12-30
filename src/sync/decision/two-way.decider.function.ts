import { parse as bytesParse } from 'bytes-iec'
import { SyncMode } from '~/settings'
import { blobStore } from '~/storage/blob'
import { hasInvalidChar } from '~/utils/has-invalid-char'
import { isSameTime } from '~/utils/is-same-time'
import logger from '~/utils/logger'
import remotePathToAbsolute from '~/utils/remote-path-to-absolute'
import { remotePathToLocalPath } from '~/utils/remote-path-to-local-path'
import { ConflictStrategy } from '../tasks/conflict-resolve.task'
import { SkipReason } from '../tasks/skipped.task'
import { BaseTask } from '../tasks/task.interface'
import {
	getIgnoredPathsInFolder,
	hasIgnoredInFolder,
} from '../utils/has-ignored-in-folder'
import { hasFolderContentChanged } from './has-folder-content-changed'
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

	// Filter out ignored files and extract StatModel from FsWalkResult
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

	logger.debug(
		'local Stats',
		localStatsFiltered.map((d) => ({
			path: d.path,
			size: d.isDir ? undefined : d.size,
			isDir: d.isDir,
		})),
	)
	logger.debug(
		'remote Stats',
		remoteStatsFiltered.map((d) => ({
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
								}),
							)
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
							}),
						)
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
						tasks.push(
							taskFactory.createSkippedTask({
								...options,
								reason: SkipReason.FileTooLarge,
								localSize: local.size,
								maxSize: maxFileSize,
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
						tasks.push(
							taskFactory.createSkippedTask({
								...options,
								reason: SkipReason.FileTooLarge,
								remoteSize: remote.size,
								localSize: local.size,
								maxSize: maxFileSize,
							}),
						)
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
						tasks.push(
							taskFactory.createSkippedTask({
								...options,
								reason: SkipReason.FileTooLarge,
								remoteSize: remote.size,
								maxSize: maxFileSize,
							}),
						)
						continue
					}
					tasks.push(
						taskFactory.createPullTask({ ...options, remoteSize: remote.size }),
					)
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
						tasks.push(
							taskFactory.createSkippedTask({
								...options,
								reason: SkipReason.FileTooLarge,
								localSize: local.size,
								maxSize: maxFileSize,
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
	for (const remote of remoteStatsFiltered) {
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
			// Use sub-items check instead of mtime check
			const remoteChanged = hasFolderContentChanged(
				remote.path,
				remoteStatsFiltered,
				syncRecords,
				'remote',
			)

			if (remoteChanged) {
				logger.debug({
					reason: 'remote folder content changed',
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

			if (hasIgnoredInFolder(remote.path, remoteStats)) {
				const ignoredPaths = getIgnoredPathsInFolder(remote.path, remoteStats)
				logger.debug({
					reason: 'skip removing remote folder (contains ignored items)',
					remotePath: remotePathToAbsolute(remoteBaseDir, remote.path),
					localPath: localPath,
					conditions: {
						hasIgnoredItems: true,
						localExists: !!local,
						recordExists: !!record,
					},
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
				reason: 'remote folder is removable (no content changes)',
				remotePath: remotePathToAbsolute(remoteBaseDir, remote.path),
				localPath: localPath,
				conditions: {
					removable: true,
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
			continue
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
	for (const local of localStatsFiltered) {
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
				// Use sub-items check instead of mtime check
				const localChanged = hasFolderContentChanged(
					local.path,
					localStatsFiltered,
					syncRecords,
					'local',
				)

				if (localChanged) {
					logger.debug({
						reason: 'local folder content changed',
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

				if (hasIgnoredInFolder(local.path, localStats)) {
					const ignoredPaths = getIgnoredPathsInFolder(local.path, localStats)
					logger.debug({
						reason: 'skip removing local folder (contains ignored items)',
						remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
						localPath: local.path,
						conditions: {
							hasIgnoredItems: true,
							remoteExists: !!remote,
							recordExists: !!record,
						},
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
					reason: 'local folder is removable (no content changes)',
					remotePath: remotePathToAbsolute(remoteBaseDir, local.path),
					localPath: local.path,
					conditions: {
						removable: true,
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

	// Sort folder tasks to ensure correct execution order
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
