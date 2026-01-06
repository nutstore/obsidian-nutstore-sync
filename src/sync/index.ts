import { chunk } from 'lodash-es'
import { Notice, Platform, Vault, moment, normalizePath } from 'obsidian'
import { dirname } from 'path-browserify'
import { Subscription } from 'rxjs'
import { WebDAVClient } from 'webdav'
import DeleteConfirmModal from '~/components/DeleteConfirmModal'
import FailedTasksModal, { FailedTaskInfo } from '~/components/FailedTasksModal'
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
import { NutstoreFileSystem } from '~/fs/nutstore'
import i18n from '~/i18n'
import { syncRecordKV } from '~/storage'
import { SyncRecord } from '~/storage/sync-record'
import breakableSleep from '~/utils/breakable-sleep'
import { getDBKey } from '~/utils/get-db-key'
import getTaskName from '~/utils/get-task-name'
import { is503Error } from '~/utils/is-503-error'
import logger from '~/utils/logger'
import { statVaultItem } from '~/utils/stat-vault-item'
import { stdRemotePath } from '~/utils/std-remote-path'
import NutstorePlugin from '..'
import TwoWaySyncDecider from './decision/two-way.decider'
import CleanRecordTask from './tasks/clean-record.task'
import MkdirRemoteTask from './tasks/mkdir-remote.task'
import NoopTask from './tasks/noop.task'
import PushTask from './tasks/push.task'
import RemoveLocalTask from './tasks/remove-local.task'
import RemoveRemoteTask from './tasks/remove-remote.task'
import SkippedTask from './tasks/skipped.task'
import { BaseTask, TaskError, TaskResult } from './tasks/task.interface'
import { mergeMkdirTasks } from './utils/merge-mkdir-tasks'
import { mergeRemoveRemoteTasks } from './utils/merge-remove-remote-tasks'
import { updateMtimeInRecord as updateMtimeInRecordUtil } from './utils/update-records'

export enum SyncStartMode {
	MANUAL_SYNC = 'manual_sync',
	AUTO_SYNC = 'auto_sync',
}

export class NutstoreSync {
	remoteFs: IFileSystem
	localFS: IFileSystem
	isCancelled: boolean = false

	private subscriptions: Subscription[] = []

	constructor(
		private plugin: NutstorePlugin,
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
				getDBKey(this.vault.getName(), this.remoteBaseDir),
				syncRecordKV,
			),
		})
		this.subscriptions.push(
			onCancelSync().subscribe(() => {
				this.isCancelled = true
			}),
		)
	}

	async start({ mode }: { mode: SyncStartMode }) {
		try {
			const showNotice = mode === SyncStartMode.MANUAL_SYNC
			emitStartSync({ showNotice })

			const settings = this.settings
			const webdav = this.webdav
			const remoteBaseDir = stdRemotePath(this.options.remoteBaseDir)
			const syncRecord = new SyncRecord(
				getDBKey(this.vault.getName(), this.remoteBaseDir),
				syncRecordKV,
			)

			let remoteBaseDirExits = await webdav.exists(remoteBaseDir)

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

			const tasks = await new TwoWaySyncDecider(this, syncRecord).decide()

			if (tasks.length === 0) {
				emitEndSync({ showNotice, failedCount: 0 })
				return
			}

			const noopTasks = tasks.filter((t) => t instanceof NoopTask)
			const skippedTasks = tasks.filter((t) => t instanceof SkippedTask)
			let confirmedTasks = tasks.filter(
				(t) => !(t instanceof NoopTask || t instanceof SkippedTask),
			)

			const firstTaskIdxNeedingConfirmation = confirmedTasks.findIndex(
				(t) => !(t instanceof CleanRecordTask),
			)

			if (
				showNotice &&
				settings.confirmBeforeSync &&
				firstTaskIdxNeedingConfirmation > -1
			) {
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

			// Check for RemoveLocalTask during auto-sync and ask for confirmation
			if (mode === SyncStartMode.AUTO_SYNC) {
				const removeLocalTasks = confirmedTasks.filter(
					(t) => t instanceof RemoveLocalTask,
				) as RemoveLocalTask[]
				if (removeLocalTasks.length > 0) {
					new Notice(i18n.t('deleteConfirm.warningNotice'), 3000)
					const { tasksToDelete, tasksToReupload } =
						await new DeleteConfirmModal(this.app, removeLocalTasks).open()

					// Create corresponding Push/Mkdir tasks for each task to reupload
					const reuploadMap = new Map<
						RemoveLocalTask,
						PushTask | MkdirRemoteTask
					>()
					const mkdirTasksMap = new Map<string, MkdirRemoteTask>()
					const pushTasks: PushTask[] = []
					// Cache paths that we've confirmed exist remotely
					const remoteExistsCache = new Set<string>()

					/**
					 * Helper function to mark a path and all its parents as existing
					 */
					const markPathAndParentsAsExisting = (remotePath: string) => {
						let current = remotePath
						while (
							current &&
							current !== '.' &&
							current !== '' &&
							current !== '/'
						) {
							if (remoteExistsCache.has(current)) {
								break // Already marked, all parents must be marked too
							}
							remoteExistsCache.add(current)
							current = stdRemotePath(dirname(current))
						}
					}

					/**
					 * Helper function to ensure parent directory exists or create mkdir task
					 */
					const ensureParentDir = async (
						localPath: string,
						remotePath: string,
					) => {
						const parentLocalPath = normalizePath(dirname(localPath))
						const parentRemotePath = stdRemotePath(dirname(remotePath))

						// Root path or vault root, no need to check
						if (
							parentLocalPath === '.' ||
							parentLocalPath === '' ||
							parentLocalPath === '/'
						) {
							return
						}

						// Already collected in new tasks, no need to check remote
						if (mkdirTasksMap.has(parentRemotePath)) {
							return
						}

						// Check if already exists in original tasks (from decider)
						const existsInOriginalTasks = tasks.some(
							(t) =>
								t instanceof MkdirRemoteTask &&
								t.remotePath === parentRemotePath,
						)
						if (existsInOriginalTasks) {
							return
						}

						// Already exists in confirmed tasks, no need to check remote
						const existsInConfirmedTasks = confirmedTasks.some(
							(t) =>
								t instanceof MkdirRemoteTask &&
								t.remotePath === parentRemotePath,
						)
						if (existsInConfirmedTasks) {
							return
						}

						// Already confirmed to exist remotely
						if (remoteExistsCache.has(parentRemotePath)) {
							return
						}

						// Check if parent directory exists remotely using webdav.stat
						try {
							await webdav.stat(parentRemotePath)
							// Directory exists, mark it and all parents as existing
							markPathAndParentsAsExisting(parentRemotePath)
						} catch (e) {
							// Directory doesn't exist, create mkdir task
							// No need to check parent's parent since createDirectory uses recursive: true
							const mkdirTask = new MkdirRemoteTask({
								vault: this.vault,
								webdav: webdav,
								remoteBaseDir: this.remoteBaseDir,
								remotePath: parentRemotePath,
								localPath: parentLocalPath,
								syncRecord: syncRecord,
							})
							mkdirTasksMap.set(parentRemotePath, mkdirTask)
						}
					}

					for (const task of tasksToReupload) {
						const stat = await statVaultItem(this.vault, task.localPath)
						if (!stat) {
							// File doesn't exist, skip
							continue
						}

						// Ensure parent directory exists
						await ensureParentDir(task.localPath, task.remotePath)

						if (stat.isDir) {
							// Directory → MkdirRemoteTask
							const mkdirTask = new MkdirRemoteTask(task.options)
							reuploadMap.set(task, mkdirTask)
							mkdirTasksMap.set(task.remotePath, mkdirTask)
						} else {
							// File → PushTask
							const pushTask = new PushTask(task.options)
							reuploadMap.set(task, pushTask)
							pushTasks.push(pushTask)
						}
					}

					const mkdirTasks = Array.from(mkdirTasksMap.values())

					// Create set of tasks to delete
					const deleteTaskSet = new Set(tasksToDelete)

					// Remove parent directory delete tasks for reupload files
					// If we reupload /a/b/c/file.png, we shouldn't delete /a, /a/b, or /a/b/c
					for (const reuploadTask of tasksToReupload) {
						let currentPath = normalizePath(reuploadTask.localPath)
						// Check all parent paths
						while (
							currentPath &&
							currentPath !== '.' &&
							currentPath !== '' &&
							currentPath !== '/'
						) {
							currentPath = normalizePath(dirname(currentPath))
							if (
								currentPath === '.' ||
								currentPath === '' ||
								currentPath === '/'
							) {
								break
							}
							// Find and remove parent directory delete tasks
							for (const deleteTask of deleteTaskSet) {
								if (deleteTask.localPath === currentPath) {
									deleteTaskSet.delete(deleteTask)
									break
								}
							}
						}
					}

					// Replace task list, putting mkdir tasks first
					const otherTasks: BaseTask[] = []
					const deleteTasks: RemoveLocalTask[] = []

					for (const t of confirmedTasks) {
						if (!(t instanceof RemoveLocalTask)) {
							otherTasks.push(t)
							continue
						}
						// If in delete list, keep RemoveLocalTask
						if (deleteTaskSet.has(t)) {
							deleteTasks.push(t)
							continue
						}
						// If in reupload list, already in mkdirTasks/pushTasks
						// If not in any list (user cancelled), skip
					}

					// Reassemble task list: mkdir → other tasks → push → delete
					confirmedTasks = [
						...mkdirTasks,
						...otherTasks,
						...pushTasks,
						...deleteTasks,
					]
				}
			}

			const confirmedTasksUniq = Array.from(
				new Set([...confirmedTasks, ...noopTasks, ...skippedTasks]),
			)

			// Merge mkdir tasks with parent-child relationships to reduce API calls
			const mkdirTasks = confirmedTasksUniq.filter(
				(t) => t instanceof MkdirRemoteTask,
			)
			const removeRemoteTasks = confirmedTasksUniq.filter(
				(t) => t instanceof RemoveRemoteTask,
			)
			const otherTasks = confirmedTasksUniq.filter(
				(t) => !(t instanceof MkdirRemoteTask || t instanceof RemoveRemoteTask),
			)
			const mergedMkdirTasks = mergeMkdirTasks(mkdirTasks)
			const mergedRemoveRemoteTasks = mergeRemoveRemoteTasks(removeRemoteTasks)
			const optimizedTasks = [
				...mergedRemoveRemoteTasks,
				...mergedMkdirTasks,
				...otherTasks,
			]

			if (confirmedTasks.length > 500 && Platform.isDesktopApp) {
				new Notice(i18n.t('sync.suggestUseClientForManyTasks'), 5000)
			}

			const hasSubstantialTask = optimizedTasks.some(
				(task) =>
					!(
						task instanceof NoopTask ||
						task instanceof CleanRecordTask ||
						task instanceof SkippedTask
					),
			)
			if (showNotice && hasSubstantialTask) {
				this.plugin.progressService.showProgressModal()
			}

			const chunkSize = 200
			const taskChunks = chunk(optimizedTasks, chunkSize)
			const allTasksResult: TaskResult[] = []

			const totalDisplayableTasks = optimizedTasks.filter(
				(t) => !(t instanceof NoopTask || t instanceof CleanRecordTask),
			)

			// Track all completed tasks across all chunks
			const allCompletedTasks: BaseTask[] = []

			for (const taskChunk of taskChunks) {
				const chunkResult = await this.execTasks(
					taskChunk,
					totalDisplayableTasks,
					allCompletedTasks,
				)
				allTasksResult.push(...chunkResult)
				await this.updateMtimeInRecord(taskChunk, chunkResult)

				if (this.isCancelled) {
					break
				}
			}

			const failedCount = allTasksResult.filter((r) => !r.success).length
			logger.debug('tasks result', allTasksResult, 'failed:', failedCount)

			if (mode === SyncStartMode.MANUAL_SYNC && failedCount > 0) {
				const failedTasksInfo: FailedTaskInfo[] = []
				for (let i = 0; i < allTasksResult.length; i++) {
					const result = allTasksResult[i]
					if (!result.success && result.error) {
						const task = result.error.task
						failedTasksInfo.push({
							taskName: getTaskName(task),
							localPath: task.options.localPath,
							errorMessage: result.error.message,
						})
					}
				}
				new FailedTasksModal(this.app, failedTasksInfo).open()
			}

			emitEndSync({ failedCount, showNotice })
		} catch (error) {
			emitSyncError(error)
			logger.error('Sync error:', error)
		} finally {
			this.subscriptions.forEach((sub) => sub.unsubscribe())
		}
	}

	private async execTasks(
		tasks: BaseTask[],
		totalDisplayableTasks: BaseTask[],
		allCompletedTasks: BaseTask[],
	) {
		const res: TaskResult[] = []
		// Filter out NoopTask and CleanRecordTask from total count for progress display
		const tasksToDisplay = tasks.filter(
			(t) => !(t instanceof NoopTask || t instanceof CleanRecordTask),
		)

		logger.debug(`Starting to execute sync tasks`, {
			totalTasks: tasks.length,
			displayedTasks: tasksToDisplay.length,
			totalDisplayableTasks: totalDisplayableTasks.length,
			alreadyCompleted: allCompletedTasks.length,
		})

		for (let i = 0; i < tasks.length; ++i) {
			const task = tasks[i]
			if (this.isCancelled) {
				emitSyncError(new TaskError(i18n.t('sync.cancelled'), task))
				break
			}

			logger.debug(
				`Executing task [${i + 1}/${tasks.length}] ${task.localPath}`,
				{
					taskName: getTaskName(task),
					taskPath: task.localPath,
				},
			)

			const taskResult = await this.executeWithRetry(task)

			logger.debug(
				`Task completed [${i + 1}/${tasks.length}] ${task.localPath}`,
				{
					taskName: getTaskName(task),
					taskPath: task.localPath,
					result: taskResult,
				},
			)

			res[i] = taskResult
			// Only add substantial tasks to completed list for progress display
			if (!(task instanceof NoopTask || task instanceof CleanRecordTask)) {
				allCompletedTasks.push(task)
				emitSyncProgress(totalDisplayableTasks.length, allCompletedTasks)
			}
		}

		const successCount = res.filter((r) => r.success).length
		logger.debug(`All tasks execution completed`, {
			totalTasks: tasks.length,
			successCount: successCount,
			failedCount: tasks.length - successCount,
		})

		return res
	}

	/**
	 * Automatically handle 503 errors and retry task execution
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
			if (!taskResult.success && is503Error(taskResult.error)) {
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

	async updateMtimeInRecord(tasks: BaseTask[], results: TaskResult[]) {
		return updateMtimeInRecordUtil(
			this.plugin,
			this.vault,
			this.remoteBaseDir,
			tasks,
			results,
			10,
		)
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

	get app() {
		return this.plugin.app
	}

	get webdav() {
		return this.options.webdav
	}

	get vault() {
		return this.options.vault
	}

	get remoteBaseDir() {
		return this.options.remoteBaseDir
	}

	get settings() {
		return this.plugin.settings
	}
}
