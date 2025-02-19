import consola, { LogLevels } from 'consola'
import dayjs from 'dayjs'
import { Vault } from 'obsidian'
import path from 'path'
import { WebDAVClient } from 'webdav'
import {
	emitEndSync,
	emitStartSync,
	emitSyncError,
	emitSyncProgress,
} from '~/events'
import IFileSystem from '~/fs/fs.interface'
import { LocalVaultFileSystem } from '~/fs/local-vault'
import { NutstoreFileSystem } from '~/fs/nutstore'
import i18n from '~/i18n'
import { SyncRecord } from '~/storage/helper'
import { isSub } from '~/utils/is-sub'
import { remotePathToLocalPath } from '~/utils/remote-path-to-local-path'
import { statVaultItem } from '~/utils/stat-vault-item'
import ConflictResolveTask, {
	ConflictStrategy,
} from './tasks/conflict-resolve.task'
import MkdirLocalTask from './tasks/mkdir-local.task'
import MkdirRemoteTask from './tasks/mkdir-remote.task'
import PullTask from './tasks/pull.task'
import PushTask from './tasks/push.task'
import RemoveLocalTask from './tasks/remove-local.task'
import RemoveRemoteTask from './tasks/remove-remote.task'
import { BaseTask } from './tasks/task.interface'

consola.level = LogLevels.verbose

export class NutStoreSync {
	private remoteFs: IFileSystem
	private localFS: IFileSystem

	constructor(
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
	}

	async prepare() {
		const webdav = this.options.webdav
		await webdav.createDirectory(this.options.remoteBaseDir, {
			recursive: true,
		})
	}

	async start() {
		await this.prepare()
		try {
			emitStartSync()

			const syncRecord = new SyncRecord(
				this.options.vault,
				this.options.remoteBaseDir,
			)
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
			consola.debug('local Stats', localStats)
			consola.debug('remote Stats', remoteStats)

			const taskOptions = {
				webdav: this.options.webdav,
				vault: this.options.vault,
				remoteBaseDir: this.options.remoteBaseDir,
			}

			const tasks: BaseTask[] = []
			const records = await syncRecord.getRecords()

			// sync folder: remote -> local
			const removeFolderTasks: RemoveRemoteTask[] = []
			for (const remote of remoteStats) {
				if (!remote.isDir) {
					continue
				}
				const localPath = this.remotePathToLocalPath(remote.path)
				const local = localStatsMap.get(localPath)
				const record = records.get(localPath)
				if (local) {
					if (!local.isDir) {
						throw new Error(
							i18n.t('sync.error.folderButFile', { path: remote.path }),
						)
					}
				} else if (record) {
					const remoteChanged = !dayjs(remote.mtime).isSame(record.remote.mtime)
					if (remoteChanged) {
						consola.debug({
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
						tasks.push(
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
							!dayjs(sub.mtime).isSame(subRecord.remote.mtime)
						) {
							removable = false
							break
						}
					}
					if (removable) {
						consola.debug({
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
						removeFolderTasks.push(
							new RemoveRemoteTask({
								...taskOptions,
								localPath: remote.path,
								remotePath: remote.path,
							}),
						)
					}
				} else {
					consola.debug({
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
					tasks.push(
						new MkdirLocalTask({
							...taskOptions,
							localPath,
							remotePath: remote.path,
						}),
					)
				}
			}

			// sync folder: local -> remote
			for (const local of localStats) {
				if (!local.isDir) {
					continue
				}
				const remote = remoteStatsMap.get(local.path)
				const record = records.get(local.path)
				if (!remote) {
					if (record) {
						const localChanged = !dayjs(local.mtime).isSame(record.local.mtime)
						if (localChanged) {
							consola.debug({
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
							tasks.push(
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
								!dayjs(sub.mtime).isSame(subRecord.local.mtime)
							) {
								removable = false
								break
							}
						}
						if (removable) {
							consola.debug({
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
							removeFolderTasks.push(
								new RemoveLocalTask({
									...taskOptions,
									localPath: local.path,
									remotePath: local.path,
								}),
							)
						}
					} else {
						consola.debug({
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
						tasks.push(
							new MkdirRemoteTask({
								...taskOptions,
								localPath: local.path,
								remotePath: local.path,
							}),
						)
					}
					continue
				}
				if (!remote.isDir) {
					throw new Error(
						i18n.t('sync.error.folderButFile', { path: remote.path }),
					)
				}
			}

			// sync files
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
						const remoteChanged = !dayjs(remote.mtime).isSame(
							record.remote.mtime,
						)
						if (local) {
							const localChanged = !dayjs(local.mtime).isSame(
								record.local.mtime,
							)
							if (remoteChanged) {
								if (localChanged) {
									consola.debug({
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
											strategy: ConflictStrategy.LatestTimeStamp,
										}),
									)
								} else {
									consola.debug({
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
								}
							} else {
								if (localChanged) {
									consola.debug({
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
								}
							}
						} else {
							if (remoteChanged) {
								consola.debug({
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
							} else {
								consola.debug({
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
							}
						}
					} else {
						if (local) {
							const localChanged = !dayjs(local.mtime).isSame(
								record.local.mtime,
							)
							if (localChanged) {
								consola.debug({
									reason: 'local file changed and remote file does not exist',
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
							} else {
								consola.debug({
									reason: 'local file is removable',
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
								tasks.push(new RemoveLocalTask(options))
							}
						}
					}
				} else {
					if (remote) {
						if (local) {
							consola.debug({
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
									strategy: ConflictStrategy.LatestTimeStamp,
								}),
							)
						} else {
							consola.debug({
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
						}
					} else {
						if (local) {
							consola.debug({
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
						}
					}
				}
			}
			removeFolderTasks.sort(
				(a, b) => b.remotePath.length - a.remotePath.length,
			)
			tasks.splice(0, 0, ...removeFolderTasks)
			consola.debug('tasks', tasks)
			const tasksResult = await this.execTasks(tasks)
			const failedCount = tasksResult.filter((r) => r === false).length
			consola.debug('tasks result', tasksResult, 'failed:', failedCount)
			// update mtime in records
			if (tasks.length > 0) {
				const latestRemoteEntities = await this.remoteFs.walk()
				const records = await syncRecord.getRecords()
				for (const task of tasks) {
					const remote = latestRemoteEntities.find(
						(v) =>
							remotePathToAbsolute(v.path, this.options.remoteBaseDir) ===
							task.remotePath,
					)
					if (!remote) {
						continue
					}
					const local = await statVaultItem(this.options.vault, task.localPath)
					if (!local) {
						continue
					}
					const file = await this.options.vault.adapter.readBinary(
						task.localPath,
					)
					records.set(task.localPath, {
						remote,
						local,
						base: new Blob([file]),
					})
				}
				await syncRecord.setRecords(records)
			}
			emitEndSync(failedCount)
		} catch (error) {
			emitSyncError(error)
			consola.error('Sync error:', error)
		}
	}

	private async execTasks(tasks: BaseTask[]) {
		const res: Awaited<ReturnType<BaseTask['exec']>>[] = []
		let completed = 0
		const total = tasks.length

		for (const t of tasks) {
			res.push(await t.exec())
			completed++
			emitSyncProgress(total, completed)
		}
		return res
	}

	remotePathToLocalPath(path: string) {
		return remotePathToLocalPath(
			this.options.vault,
			this.options.remoteBaseDir,
			path,
		)
	}
}

function remotePathToAbsolute(
	remotePath: string,
	remoteBaseDir: string,
): string {
	return path.isAbsolute(remotePath)
		? remotePath
		: path.resolve(remoteBaseDir, remotePath)
}
