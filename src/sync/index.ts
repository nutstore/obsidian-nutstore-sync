import { isNil } from 'lodash-es'
import { Notice, Platform, Vault, moment } from 'obsidian'
import { Subscription } from 'rxjs'
import { WebDAVClient } from 'webdav'
import TaskListConfirmModal from '~/components/TaskListConfirmModal'
import {
	emitEndSync,
	emitStartSync,
	emitSyncError,
	emitSyncProgress,
	emitSyncUpdateMtimeProgress,
	onCancelSync,
} from '~/events'
import IFileSystem from '~/fs/fs.interface'
import { LocalVaultFileSystem } from '~/fs/local-vault'
import { NutstoreFileSystem } from '~/fs/nutstore'
import i18n from '~/i18n'
import { blobStore } from '~/storage/blob'
import { SyncRecord } from '~/storage/helper'
import breakableSleep from '~/utils/breakable-sleep'
import getTaskName from '~/utils/get-task-name'
import { is503Error } from '~/utils/is-503-error'
import { isBinaryFile } from '~/utils/is-binary-file'
import logger from '~/utils/logger'
import { statVaultItem } from '~/utils/stat-vault-item'
import { stdRemotePath } from '~/utils/std-remote-path'
import NutstorePlugin from '..'
import TwoWaySyncDecision from './decision/two-way.decision'
import NoopTask from './tasks/noop.task'
import { BaseTask, TaskError, TaskResult } from './tasks/task.interface'

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

	async start({ showNotice }: { showNotice: boolean }) {
		try {
			emitStartSync({ showNotice })

			const settings = this.settings
			const webdav = this.webdav
			const remoteBaseDir = stdRemotePath(this.options.remoteBaseDir)
			const syncRecord = new SyncRecord(this.vault, this.remoteBaseDir)

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

			const tasks = await new TwoWaySyncDecision(this).decide()

			if (tasks.length === 0) {
				emitEndSync({ showNotice, failedCount: 0 })
				return
			}

			let confirmedTasks = tasks

			if (showNotice) {
				confirmedTasks = tasks.filter((t) => !(t instanceof NoopTask))
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

			if (showNotice && confirmedTasksUniq.length > 0) {
				this.plugin.progressService.showProgressModal()
			}

			await this.saveLogs()

			const tasksResult = await this.execTasks(confirmedTasksUniq)
			const failedCount = tasksResult.filter((r) => !r.success).length

			logger.debug('tasks result', tasksResult, 'failed:', failedCount)

			await this.updateMtimeInRecord(confirmedTasksUniq, tasksResult)

			emitEndSync({ failedCount, showNotice })
		} catch (error) {
			emitSyncError(error)
			logger.error('Sync error:', error)
		} finally {
			this.subscriptions.forEach((sub) => sub.unsubscribe())
		}
	}

	private async execTasks(tasks: BaseTask[]) {
		const res: TaskResult[] = []
		const total = tasks.length
		const completed: BaseTask[] = []

		logger.debug(`Starting to execute sync tasks`, {
			totalTasks: total,
		})

		for (let i = 0; i < tasks.length; ++i) {
			const task = tasks[i]
			if (this.isCancelled) {
				emitSyncError(new TaskError(i18n.t('sync.cancelled'), task))
				break
			}

			logger.debug(`Executing task [${i + 1}/${total}] ${task.localPath}`, {
				taskName: getTaskName(task),
				taskPath: task.localPath,
			})

			await this.saveLogs()
			const taskResult = await this.executeWithRetry(task)

			logger.debug(`Task completed [${i + 1}/${total}] ${task.localPath}`, {
				taskName: getTaskName(task),
				taskPath: task.localPath,
				result: taskResult,
			})

			res[i] = taskResult
			completed.push(task)
			emitSyncProgress(total, completed)
		}

		const successCount = res.filter((r) => r.success).length
		logger.debug(`All tasks execution completed`, {
			totalTasks: total,
			successCount: successCount,
			failedCount: total - successCount,
		})

		await this.saveLogs()

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

	async updateMtimeInRecord(tasks: BaseTask[], results: TaskResult[]) {
		if (tasks.length === 0) {
			return
		}
		const latestRemoteEntities = await this.remoteFs.walk()
		const syncRecord = new SyncRecord(
			this.options.vault,
			this.options.remoteBaseDir,
		)
		const records = await syncRecord.getRecords()
		const startAt = Date.now()
		const BATCH_SIZE = 10
		let completedCount = 0
		for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
			const batch = tasks.slice(i, i + BATCH_SIZE).map(async (task, j) => {
				try {
					const idx = i + j
					if (!results[idx]?.success) {
						return
					}
					completedCount++
					const remote = latestRemoteEntities.find(
						(entity) => entity.path === task.localPath,
					)
					if (!remote) {
						return
					}
					const local = await statVaultItem(this.options.vault, task.localPath)
					if (!local) {
						return
					}
					let baseKey: string | undefined
					if (!local.isDir) {
						const file = this.options.vault.getFileByPath(task.localPath)
						if (!file) {
							return
						}
						const buffer = await this.options.vault.readBinary(file)
						if (await isBinaryFile(buffer)) {
							baseKey = undefined
						} else {
							const { key } = await blobStore.store(buffer)
							baseKey = key
						}
					}
					records.set(task.localPath, {
						remote,
						local,
						base: isNil(baseKey) ? undefined : { key: baseKey },
					})
				} catch (e) {
					logger.error(
						'updateMtimeInRecord',
						{
							errorName: e.name,
							errorMsg: e.message,
						},
						task.toJSON(),
					)
				}
			})
			await Promise.all(batch)
			emitSyncUpdateMtimeProgress(tasks.length, completedCount)
			await syncRecord.setRecords(records)
		}
		logger.debug(`Records saving completed`, {
			recordsSize: records.size,
			elapsedMs: Date.now() - startAt,
		})
		await this.saveLogs()
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

	async saveLogs() {
		await this.plugin.loggerService.saveLogs()
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
