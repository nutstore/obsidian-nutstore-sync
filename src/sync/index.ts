import { App, Notice, Platform, Vault, moment } from 'obsidian'
import { isAbsolute, join } from 'path'
import { Subscription } from 'rxjs'
import { WebDAVClient } from 'webdav'
import TaskListConfirmModal from '~/components/TaskListConfirmModal'
import {
	emitEndSync,
	emitStartSync,
	emitSyncError,
	emitSyncProgress,
	onCancelSync,
} from '~/events'
import IFileSystem from '~/fs/fs.interface'
import { LocalVaultFileSystem } from '~/fs/local-vault'
import memfs from '~/fs/memfs'
import { NutstoreFileSystem } from '~/fs/nutstore'
import i18n from '~/i18n'
import { SyncMode, useSettings } from '~/settings'
import { SyncRecord } from '~/storage/helper'
import breakableSleep from '~/utils/breakable-sleep'
import { is503Error } from '~/utils/is-503-error'
import { isBinaryFile } from '~/utils/is-binary-file'
import { isSub } from '~/utils/is-sub'
import logger from '~/utils/logger'
import { remotePathToLocalPath } from '~/utils/remote-path-to-local-path'
import { statVaultItem } from '~/utils/stat-vault-item'
import { stdRemotePath } from '~/utils/std-remote-path'
import ConflictResolveTask, {
	ConflictStrategy,
} from './tasks/conflict-resolve.task'
import MkdirLocalTask from './tasks/mkdir-local.task'
import MkdirRemoteTask from './tasks/mkdir-remote.task'
import NoopTask from './tasks/noop.task'
import PullTask from './tasks/pull.task'
import PushTask from './tasks/push.task'
import RemoveLocalTask from './tasks/remove-local.task'
import RemoveRemoteTask from './tasks/remove-remote.task'
import { BaseTask, TaskError, TaskResult } from './tasks/task.interface'

export class NutstoreSync {
	private remoteFs: IFileSystem
	private localFS: IFileSystem
	private isCancelled: boolean = false
	private subscriptions: Subscription[] = []

	constructor(
		private app: App,
		private options: {
			vault: Vault
			token: string
			remoteBaseDir: string
			webdav: WebDAVClient
		},
	) {
		this.options = Object.freeze(this.options)
		this.remoteFs = new NutstoreFileSystem(this.options)
		this.localFS = new LocalVaultFileSystem({
			vault: this.options.vault,
			syncRecord: new SyncRecord(
				this.options.vault,
				this.options.remoteBaseDir,
			),
		})
		this.subscriptions.push(
			onCancelSync().subscribe(() => {
				this.isCancelled = true
			}),
		)
	}

	async start() {
		try {
			const settings = useSettings()
			const webdav = this.options.webdav
			emitStartSync()
			const remoteBaseDir = stdRemotePath(this.options.remoteBaseDir)
			let remoteBaseDirExits = await webdav.exists(remoteBaseDir)
			const syncRecord = new SyncRecord(
				this.options.vault,
				this.options.remoteBaseDir,
			)
			const records = await syncRecord.getRecords()
			if (!remoteBaseDirExits) {
				await syncRecord.drop()
			}
			while (!remoteBaseDirExits) {
				if (this.isCancelled) {
					emitSyncError(new Error(i18n.t('sync.cancelled')))
					return
				}
				try {
					await webdav.createDirectory(this.options.remoteBaseDir, {
						recursive: true,
					})
					break
				} catch (e) {
					if (is503Error(e)) {
						await this.handle503Error(60000)
						if (this.isCancelled) {
							emitSyncError(new Error(i18n.t('sync.cancelled')))
							return
						}
						remoteBaseDirExits = await webdav.exists(remoteBaseDir)
					} else {
						throw e
					}
				}
			}

			const localStats = await this.localFS.walk()
			const remoteStats = await this.remoteFs.walk()
			const localStatsMap = new Map(localStats.map((item) => [item.path, item]))
			const remoteStatsMap = new Map(
				remoteStats.map((item) => [item.path, item]),
			)
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
				webdav,
				vault: this.options.vault,
				remoteBaseDir: this.options.remoteBaseDir,
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
							const localChanged = !moment(local.mtime).isSame(
								record.local.mtime,
							)
							if (remoteChanged) {
								if (localChanged) {
									logger.debug({
										reason: 'both local and remote files changed',
										remotePath: remotePathToAbsolute(
											p,
											this.options.remoteBaseDir,
										),
										localPath: p,
										conditions: {
											remoteChanged,
											localChanged,
											recordExists: !!record,
											remoteExists: !!remote,
											localExists: !!local,
										},
									})
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
										remotePath: remotePathToAbsolute(
											p,
											this.options.remoteBaseDir,
										),
										localPath: p,
										conditions: {
											remoteChanged,
											recordExists: !!record,
											remoteExists: !!remote,
											localExists: !!local,
										},
									})
									tasks.push(new PullTask(options))
									continue
								}
							} else {
								if (localChanged) {
									logger.debug({
										reason: 'local file changed',
										remotePath: remotePathToAbsolute(
											p,
											this.options.remoteBaseDir,
										),
										localPath: p,
										conditions: {
											localChanged,
											recordExists: !!record,
											remoteExists: !!remote,
											localExists: !!local,
										},
									})
									tasks.push(new PushTask(options))
									continue
								}
							}
						} else {
							if (remoteChanged) {
								logger.debug({
									reason: 'remote file changed and local file does not exist',
									remotePath: remotePathToAbsolute(
										p,
										this.options.remoteBaseDir,
									),
									localPath: p,
									conditions: {
										remoteChanged,
										recordExists: !!record,
										remoteExists: !!remote,
										localExists: !!local,
									},
								})
								tasks.push(new PullTask(options))
								continue
							} else {
								logger.debug({
									reason: 'remote file is removable',
									remotePath: remotePathToAbsolute(
										p,
										this.options.remoteBaseDir,
									),
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
								remotePath: remotePathToAbsolute(p, this.options.remoteBaseDir),
								localPath: p,
								conditions: {
									localChanged,
									recordExists: !!record,
									remoteExists: !!remote,
									localExists: !!local,
								},
							})
							tasks.push(new PushTask(options))
							continue
						} else {
							logger.debug({
								reason: 'local file is removable',
								remotePath: remotePathToAbsolute(p, this.options.remoteBaseDir),
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
								remotePath: remotePathToAbsolute(p, this.options.remoteBaseDir),
								localPath: p,
								conditions: {
									recordExists: !!record,
									remoteExists: !!remote,
									localExists: !!local,
								},
							})
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
								remotePath: remotePathToAbsolute(p, this.options.remoteBaseDir),
								localPath: p,
								conditions: {
									recordExists: !!record,
									remoteExists: !!remote,
									localExists: !!local,
								},
							})
							tasks.push(new PullTask(options))
							continue
						}
					} else {
						if (local) {
							logger.debug({
								reason: 'local file exists without a remote file',
								remotePath: remotePathToAbsolute(p, this.options.remoteBaseDir),
								localPath: p,
								conditions: {
									recordExists: !!record,
									remoteExists: !!remote,
									localExists: !!local,
								},
							})
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
				const localPath = remotePathToLocalPath(
					this.options.remoteBaseDir,
					remote.path,
				)
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
					const remoteChanged = !moment(remote.mtime).isSame(
						record.remote.mtime,
					)
					if (remoteChanged) {
						logger.debug({
							reason: 'remote folder changed',
							remotePath: remotePathToAbsolute(
								remote.path,
								this.options.remoteBaseDir,
							),
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
					// 如果远程文件夹里没有修改过的文件 或者没有不在syncRecord里的路径 那就可以把整个文件夹都删咯!
					let removable = true
					for (const sub of remoteStats) {
						if (!isSub(remote.path, sub.path)) {
							continue
						}
						const subRecord = records.get(sub.path)
						if (
							!subRecord ||
							!moment(sub.mtime).isSame(subRecord.remote.mtime)
						) {
							removable = false
							break
						}
					}
					if (removable) {
						logger.debug({
							reason: 'remote folder is removable',
							remotePath: remotePathToAbsolute(
								remote.path,
								this.options.remoteBaseDir,
							),
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
						remotePath: remotePathToAbsolute(
							remote.path,
							this.options.remoteBaseDir,
						),
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
								remotePath: remotePathToAbsolute(
									local.path,
									this.options.remoteBaseDir,
								),
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
						// 远程以前有文件夹 现在没了 如果本地这个文件夹里没没有发生修改 那么也应该删除本地的文件夹!
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
								remotePath: remotePathToAbsolute(
									local.path,
									this.options.remoteBaseDir,
								),
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
							remotePath: remotePathToAbsolute(
								local.path,
								this.options.remoteBaseDir,
							),
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

			if (tasks.length === 0) {
				emitEndSync(0)
				return
			}

			let confirmedTasks = tasks.filter((t) => !(t instanceof NoopTask))
			if (settings.confirmBeforeSync && confirmedTasks.length > 0) {
				const confirmExec = await new TaskListConfirmModal(
					this.app,
					confirmedTasks,
				).open()
				if (confirmExec.confirm) {
					confirmedTasks = confirmExec.tasks
				} else {
					emitSyncError(new Error(i18n.t('sync.cancelled')))
					return
				}
			}
			const confirmedTasksUniq = Array.from(
				new Set([
					...confirmedTasks,
					...tasks.filter((t) => t instanceof NoopTask),
				]),
			)
			if (confirmedTasksUniq.length > 500 && Platform.isDesktopApp) {
				new Notice(i18n.t('sync.suggestUseClientForManyTasks'), 5000)
			}
			const tasksResult = await this.execTasks(confirmedTasksUniq)
			const failedCount = tasksResult.filter((r) => !r.success).length
			logger.debug('tasks result', tasksResult, 'failed:', failedCount)
			await this.updateMtimeInRecord(confirmedTasksUniq, tasksResult)
			emitEndSync(failedCount)
		} catch (error) {
			emitSyncError(error)
			logger.error('Sync error:', error)
		} finally {
			this.subscriptions.forEach((sub) => sub.unsubscribe())
		}
	}

	async updateMtimeInRecord(tasks: BaseTask[], results: TaskResult[]) {
		if (tasks.length === 0) {
			return
		}
		const latestRemoteEntities = await this.remoteFs.walk()
		const latestRemoteMemfs = new memfs(latestRemoteEntities)
		const syncRecord = new SyncRecord(
			this.options.vault,
			this.options.remoteBaseDir,
		)
		const records = await syncRecord.getRecords()
		const startAt = Date.now()
		for (let i = 0; i < tasks.length; ++i) {
			const task = tasks[i]
			if (!results[i]?.success) {
				continue
			}
			const remote = latestRemoteMemfs.stat(task.localPath)
			if (!remote) {
				continue
			}
			const local = await statVaultItem(this.options.vault, task.localPath)
			if (!local) {
				continue
			}
			let base: Blob | undefined
			if (!local.isDir) {
				const buffer = await this.options.vault.adapter.readBinary(
					task.localPath,
				)
				if (!(await isBinaryFile(buffer))) {
					base = new Blob([buffer])
				}
			}
			records.set(task.localPath, {
				remote,
				local,
				base,
			})
		}
		await syncRecord.setRecords(records)
		logger.info(`write into record in ${Date.now() - startAt}ms`)
	}

	private async handle503Error(waitMs: number) {
		const now = Date.now()
		const startAt = now + waitMs
		new Notice(
			i18n.t('sync.requestsTooFrequent', {
				time: moment(startAt).format('HH:mm:ss'),
			}),
		)
		await breakableSleep(onCancelSync(), startAt - now)
	}

	/**
	 * 自动处理503错误并重试的任务执行
	 */
	private async executeWithRetry(task: BaseTask): Promise<TaskResult> {
		while (true) {
			if (this.isCancelled) {
				return {
					success: false,
					error: new TaskError(i18n.t('sync.cancelled'), task),
				}
			}
			const taskResult = await task.exec()
			if (taskResult.error && is503Error(taskResult.error)) {
				await this.handle503Error(60000)
				if (this.isCancelled) {
					return {
						success: false,
						error: new TaskError(i18n.t('sync.cancelled'), task),
					}
				}
				continue
			}
			return taskResult
		}
	}

	private async execTasks(tasks: BaseTask[]) {
		const res: TaskResult[] = []
		const total = tasks.length
		const completed: BaseTask[] = []
		for (let i = 0; i < tasks.length; ++i) {
			const task = tasks[i]
			if (this.isCancelled) {
				emitSyncError(new TaskError(i18n.t('sync.cancelled'), task))
				break
			}
			const taskResult = await this.executeWithRetry(task)
			res[i] = taskResult
			completed.push(task)
			emitSyncProgress(total, completed)
		}
		return res
	}
}

function remotePathToAbsolute(
	remotePath: string,
	remoteBaseDir: string,
): string {
	return isAbsolute(remotePath) ? remotePath : join(remoteBaseDir, remotePath)
}
