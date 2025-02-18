import dayjs from 'dayjs'
import { Notice, Vault } from 'obsidian'
import { WebDAVClient } from 'webdav'
import IFileSystem from '~/fs/fs.interface'
import { LocalVaultFileSystem } from '~/fs/local-vault'
import { NutstoreFileSystem } from '~/fs/nutstore'
import i18n from '~/i18n'
import { SyncRecord } from '~/storage/helper'
import { isSub } from '~/utils/is-sub'
import { remotePathToLocalPath } from '~/utils/remote-path-to-local-path'
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
			new Notice(i18n.t('sync.start'))
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
			console.debug('local Stats', localStats)
			console.debug('remote Stats', remoteStats)

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
						new Notice(i18n.t('sync.failed'))
						throw new Error(
							i18n.t('sync.error.folderButFile', { path: remote.path }),
						)
					}
				} else if (record) {
					const remoteChanged = !dayjs(remote.mtime).isSame(record.remote.mtime)
					if (remoteChanged) {
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
						removeFolderTasks.push(
							new RemoveRemoteTask({
								...taskOptions,
								localPath: remote.path,
								remotePath: remote.path,
							}),
						)
					}
				} else {
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
							tasks.push(
								new RemoveLocalTask({
									...taskOptions,
									localPath: local.path,
									remotePath: local.path,
								}),
							)
						}
					} else {
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
					new Notice(i18n.t('sync.failed'))
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
									tasks.push(
										new ConflictResolveTask({
											...options,
											record,
											strategy: ConflictStrategy.LatestTimeStamp,
										}),
									)
								} else {
									console.log(0)

									tasks.push(new PullTask(options))
								}
							} else {
								if (localChanged) {
									tasks.push(new PushTask(options))
								}
							}
						} else {
							if (remoteChanged) {
								console.log(1)

								tasks.push(new PullTask(options))
							} else {
								tasks.push(new RemoveRemoteTask(options))
							}
						}
					} else {
						if (local) {
							const localChanged = !dayjs(local.mtime).isSame(
								record.local.mtime,
							)
							if (localChanged) {
								tasks.push(new PushTask(options))
							} else {
								tasks.push(new RemoveLocalTask(options))
							}
						}
					}
				} else {
					if (remote) {
						if (local) {
							tasks.push(
								new ConflictResolveTask({
									...options,
									strategy: ConflictStrategy.LatestTimeStamp,
								}),
							)
						} else {
							console.log(2)

							tasks.push(new PullTask(options))
						}
					} else {
						if (local) {
							tasks.push(new PushTask(options))
						}
					}
				}
			}

			removeFolderTasks.sort(
				(a, b) => b.remotePath.length - a.remotePath.length,
			)
			console.log('remove folder tasks:', removeFolderTasks)
			console.debug('tasks', tasks)
			const tasksResult = await execTasks(tasks)
			const removeFolderTasksResult = await execTasks(removeFolderTasks)
			console.debug('tasks result', tasksResult)
			console.debug('remove folder tasks result:', removeFolderTasksResult)
			new Notice(i18n.t('sync.complete'))
		} catch (error) {
			console.error('Sync error:', error)
			new Notice(i18n.t('sync.failedWithError', { error: error.message }))
		}
	}

	remotePathToLocalPath(path: string) {
		return remotePathToLocalPath(
			this.options.vault,
			this.options.remoteBaseDir,
			path,
		)
	}
}

async function execTasks(tasks: BaseTask[]) {
	const res: Awaited<ReturnType<BaseTask['exec']>>[] = []
	for (const t of tasks) {
		res.push(await t.exec())
	}
	return res
}
