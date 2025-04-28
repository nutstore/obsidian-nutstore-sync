import { parse as bytesParse } from 'bytes-iec'
import { moment } from 'obsidian'
import i18n from '~/i18n'
import { SyncMode } from '~/settings'
import { SyncRecord } from '~/storage/helper'
import { isSub } from '~/utils/is-sub'
import logger from '~/utils/logger'
import remotePathToAbsolute from '~/utils/remote-path-to-absolute'
import { remotePathToLocalPath } from '~/utils/remote-path-to-local-path'
import ConflictResolveTask, {
	ConflictStrategy,
} from '../tasks/conflict-resolve.task'
import MkdirLocalTask from '../tasks/mkdir-local.task'
import MkdirRemoteTask from '../tasks/mkdir-remote.task'
import NoopTask from '../tasks/noop.task'
import PullTask from '../tasks/pull.task'
import PushTask from '../tasks/push.task'
import RemoveLocalTask from '../tasks/remove-local.task'
import RemoveRemoteTask from '../tasks/remove-remote.task'
import { BaseTask } from '../tasks/task.interface'
import BaseSyncDecision from './base.decision'

export default class TwoWaySyncDecision extends BaseSyncDecision {
	async decide() {
		const settings = this.settings

		let maxFileSize = Infinity
		const maxFileSizeStr = settings.skipLargeFiles.maxSize.trim()
		if (maxFileSizeStr !== '') {
			maxFileSize = bytesParse(maxFileSizeStr) ?? Infinity
		}

		const syncRecord = new SyncRecord(this.vault, this.remoteBaseDir)
		const [records, localStats, remoteStats] = await Promise.all([
			syncRecord.getRecords(),
			this.sync.localFS.walk(),
			this.sync.remoteFs.walk(),
		])
		const localStatsMap = new Map(localStats.map((item) => [item.path, item]))
		const remoteStatsMap = new Map(remoteStats.map((item) => [item.path, item]))
		const mixedPath = new Set([
			...localStatsMap.keys(),
			...remoteStatsMap.keys(),
		])
		logger.debug(
			'local Stats',
			localStats.map((d) => ({
				path: d.path,
				size: d.size,
				isDir: d.isDir,
			})),
		)
		logger.debug(
			'remote Stats',
			remoteStats.map((d) => ({
				path: d.path,
				size: d.size,
				isDir: d.isDir,
			})),
		)

		const taskOptions = {
			webdav: this.webdav,
			vault: this.vault,
			remoteBaseDir: this.remoteBaseDir,
		}

		const tasks: BaseTask[] = []
		const removeRemoteFolderTasks: RemoveRemoteTask[] = []
		const removeLocalFolderTasks: RemoveLocalTask[] = []
		const mkdirLocalTasks: MkdirLocalTask[] = []
		const mkdirRemoteTasks: MkdirRemoteTask[] = []
		const noopFolderTasks: NoopTask[] = []

		// * sync files
		for (const p of mixedPath) {
			const remote = remoteStatsMap.get(p)
			const local = localStatsMap.get(p)
			const record = records.get(p)
			const options = {
				...taskOptions,
				remotePath: p,
				localPath: p,
			}
			if (local?.isDir || remote?.isDir) {
				continue
			}
			if (record) {
				if (remote) {
					const remoteChanged = !moment(remote.mtime).isSame(
						record.remote.mtime,
					)
					if (local) {
						const localChanged = !moment(local.mtime).isSame(record.local.mtime)
						if (remoteChanged) {
							if (localChanged) {
								logger.debug({
									reason: 'both local and remote files changed',
									remotePath: remotePathToAbsolute(this.remoteBaseDir, p),
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
								tasks.push(
									new ConflictResolveTask({
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
								continue
							} else {
								logger.debug({
									reason: 'remote file changed',
									remotePath: remotePathToAbsolute(this.remoteBaseDir, p),
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
								tasks.push(new PullTask(options))
								continue
							}
						} else {
							if (localChanged) {
								logger.debug({
									reason: 'local file changed',
									remotePath: remotePathToAbsolute(this.remoteBaseDir, p),
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
								tasks.push(new PushTask(options))
								continue
							}
						}
					} else {
						if (remoteChanged) {
							logger.debug({
								reason: 'remote file changed and local file does not exist',
								remotePath: remotePathToAbsolute(this.remoteBaseDir, p),
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
							tasks.push(new PullTask(options))
							continue
						} else {
							logger.debug({
								reason: 'remote file is removable',
								remotePath: remotePathToAbsolute(this.remoteBaseDir, p),
								localPath: p,
								conditions: {
									recordExists: !!record,
									remoteExists: !!remote,
									localExists: !!local,
								},
							})
							tasks.push(new RemoveRemoteTask(options))
							continue
						}
					}
				} else if (local) {
					const localChanged = !moment(local.mtime).isSame(record.local.mtime)
					if (localChanged) {
						logger.debug({
							reason: 'local file changed and remote file does not exist',
							remotePath: remotePathToAbsolute(this.remoteBaseDir, p),
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
						tasks.push(new PushTask(options))
						continue
					} else {
						logger.debug({
							reason: 'local file is removable',
							remotePath: remotePathToAbsolute(this.remoteBaseDir, p),
							localPath: p,
							conditions: {
								recordExists: !!record,
								remoteExists: !!remote,
								localExists: !!local,
							},
						})
						tasks.push(new RemoveLocalTask(options))
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
								new NoopTask({
									...options,
								}),
							)
							continue
						}
						logger.debug({
							reason: 'both local and remote files exist without a record',
							remotePath: remotePathToAbsolute(this.remoteBaseDir, p),
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
						tasks.push(
							new ConflictResolveTask({
								...options,
								strategy: ConflictStrategy.DiffMatchPatch,
								localStat: local,
								remoteStat: remote,
								useGitStyle: settings.useGitStyle,
							}),
						)
						continue
					} else {
						logger.debug({
							reason: 'remote file exists without a local file',
							remotePath: remotePathToAbsolute(this.remoteBaseDir, p),
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
						tasks.push(new PullTask(options))
						continue
					}
				} else {
					if (local) {
						logger.debug({
							reason: 'local file exists without a remote file',
							remotePath: remotePathToAbsolute(this.remoteBaseDir, p),
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
						tasks.push(new PushTask(options))
						continue
					}
				}
			}
		}

		// * sync folder: remote -> local
		for (const remote of remoteStats) {
			if (!remote.isDir) {
				continue
			}
			const localPath = remotePathToLocalPath(this.remoteBaseDir, remote.path)
			const local = localStatsMap.get(localPath)
			const record = records.get(localPath)
			if (local) {
				if (!local.isDir) {
					throw new Error(
						i18n.t('sync.error.folderButFile', { path: remote.path }),
					)
				}
				if (!record) {
					noopFolderTasks.push(
						new NoopTask({
							...taskOptions,
							localPath: localPath,
							remotePath: remote.path,
						}),
					)
					continue
				}
			} else if (record) {
				const remoteChanged = !moment(remote.mtime).isSame(record.remote.mtime)
				if (remoteChanged) {
					logger.debug({
						reason: 'remote folder changed',
						remotePath: remotePathToAbsolute(this.remoteBaseDir, remote.path),
						localPath: localPath,
						conditions: {
							remoteChanged,
							localExists: !!local,
							recordExists: !!record,
						},
					})
					mkdirLocalTasks.push(
						new MkdirLocalTask({
							...taskOptions,
							localPath,
							remotePath: remote.path,
						}),
					)
					continue
				}
				// If there are no modified files in the remote folder or no paths that aren't in syncRecord, then the entire folder can be deleted!
				let removable = true
				for (const sub of remoteStats) {
					if (!isSub(remote.path, sub.path)) {
						continue
					}
					const subRecord = records.get(sub.path)
					if (!subRecord || !moment(sub.mtime).isSame(subRecord.remote.mtime)) {
						removable = false
						break
					}
				}
				if (removable) {
					logger.debug({
						reason: 'remote folder is removable',
						remotePath: remotePathToAbsolute(this.remoteBaseDir, remote.path),
						localPath: localPath,
						conditions: {
							removable,
							localExists: !!local,
							recordExists: !!record,
						},
					})
					removeRemoteFolderTasks.push(
						new RemoveRemoteTask({
							...taskOptions,
							localPath: remote.path,
							remotePath: remote.path,
						}),
					)
				}
			} else {
				logger.debug({
					reason: 'remote folder does not exist locally',
					remotePath: remotePathToAbsolute(this.remoteBaseDir, remote.path),
					localPath: localPath,
					conditions: {
						localExists: !!local,
						recordExists: !!record,
					},
				})
				mkdirLocalTasks.push(
					new MkdirLocalTask({
						...taskOptions,
						localPath,
						remotePath: remote.path,
					}),
				)
				continue
			}
		}

		// * sync folder: local -> remote
		for (const local of localStats) {
			if (!local.isDir) {
				continue
			}
			const remote = remoteStatsMap.get(local.path)
			const record = records.get(local.path)
			if (remote) {
				if (!record) {
					noopFolderTasks.push(
						new NoopTask({
							...taskOptions,
							localPath: local.path,
							remotePath: remote.path,
						}),
					)
					continue
				}
			} else {
				if (record) {
					const localChanged = !moment(local.mtime).isSame(record.local.mtime)
					if (localChanged) {
						logger.debug({
							reason: 'local folder changed',
							remotePath: remotePathToAbsolute(this.remoteBaseDir, local.path),
							localPath: local.path,
							conditions: {
								localChanged,
								remoteExists: !!remote,
								recordExists: !!record,
							},
						})
						mkdirRemoteTasks.push(
							new MkdirRemoteTask({
								...taskOptions,
								localPath: local.path,
								remotePath: local.path,
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
						const subRecord = records.get(sub.path)
						if (
							!subRecord ||
							!moment(sub.mtime).isSame(subRecord.local.mtime)
						) {
							removable = false
							break
						}
					}
					if (removable) {
						logger.debug({
							reason: 'local folder is removable',
							remotePath: remotePathToAbsolute(this.remoteBaseDir, local.path),
							localPath: local.path,
							conditions: {
								removable,
								remoteExists: !!remote,
								recordExists: !!record,
							},
						})
						removeLocalFolderTasks.push(
							new RemoveLocalTask({
								...taskOptions,
								localPath: local.path,
								remotePath: local.path,
							}),
						)
					}
				} else {
					logger.debug({
						reason: 'local folder does not exist remotely',
						remotePath: remotePathToAbsolute(this.remoteBaseDir, local.path),
						localPath: local.path,
						conditions: {
							remoteExists: !!remote,
							recordExists: !!record,
						},
					})
					mkdirRemoteTasks.push(
						new MkdirRemoteTask({
							...taskOptions,
							localPath: local.path,
							remotePath: local.path,
						}),
					)
					continue
				}
				continue
			}
			if (!remote.isDir) {
				throw new Error(
					i18n.t('sync.error.folderButFile', { path: remote.path }),
				)
			}
		}

		removeRemoteFolderTasks.sort(
			(a: RemoveRemoteTask, b: RemoveRemoteTask) =>
				b.remotePath.length - a.remotePath.length,
		)
		removeLocalFolderTasks.sort(
			(a: RemoveLocalTask, b: RemoveLocalTask) =>
				b.localPath.length - a.localPath.length,
		)
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
}
