import { chunk } from 'es-toolkit/compat'
import { Notice, Platform, Vault, moment, normalizePath } from 'obsidian'
import { dirname } from 'path-browserify'
import { Subscription } from 'rxjs'
import { WebDAVClient } from 'webdav'
import DeleteConfirmModal from '~/components/DeleteConfirmModal'
import TaskListConfirmModal from '~/components/TaskListConfirmModal'
import {
	emitEndSync,
	emitPreparingSync,
	emitStartSync,
	emitSyncCancelled,
	emitSyncError,
	emitSyncPreparationProgress,
	emitSyncProgress,
	onCancelSync,
	type SyncPreparationProgress,
} from '~/events'
import IFileSystem from '~/fs/fs.interface'
import { LocalVaultFileSystem } from '~/fs/local-vault'
import { NutstoreFileSystem } from '~/fs/nutstore'
import i18n from '~/i18n'
import { closeModalOnAbort } from '~/modules/modal-lifetime'
import CacheService from '~/services/cache.service.v1'
import { SyncPolicy } from '~/settings'
import { syncRecordKV } from '~/storage'
import { SyncRecord } from '~/storage/sync-record'
import {
	createSyncLogger,
	formatSyncLogPrefix,
	type SyncLogger,
} from '~/sync/log'
import { isAbortError } from '~/utils/abort'
import breakableSleep from '~/utils/breakable-sleep'
import { computeEffectiveFilterRules } from '~/utils/config-dir-rules'
import { describeSyncError } from '~/utils/describe-sync-error'
import { getDBKey } from '~/utils/get-db-key'
import getTaskName from '~/utils/get-task-name'
import { is503Error } from '~/utils/is-503-error'
import {
	getNutstoreDavEndpoint,
	getNutstoreNsdavEndpoint,
} from '~/utils/nutstore-endpoints'
import { statVaultItem } from '~/utils/stat-vault-item'
import { stdRemotePath } from '~/utils/std-remote-path'
import NutstorePlugin from '..'
import ReceiveOnlySyncDecider, {
	ReceiveOnlyRevertLocalChangesSyncDecider,
} from './decision/receive-only.decider'
import SendOnlySyncDecider, {
	SendOnlyOverrideChangesSyncDecider,
} from './decision/send-only.decider'
import TwoWaySyncDecider from './decision/two-way.decider'
import { SyncScope } from './scope'
import CleanRecordTask from './tasks/clean-record.task'
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
import SkippedTask from './tasks/skipped.task'
import { BaseTask, TaskError, TaskResult } from './tasks/task.interface'
import { mergeMkdirTasks } from './utils/merge-mkdir-tasks'
import { mergeRemoveRemoteTasks } from './utils/merge-remove-remote-tasks'
import {
	countRecordUpdateOperations,
	updateMtimeInRecord as updateMtimeInRecordUtil,
	type UpdateMtimeProgress,
} from './utils/update-records'

export enum SyncStartMode {
	MANUAL_SYNC = 'manual_sync',
	AUTO_SYNC = 'auto_sync',
}

class SyncCancelledError extends Error {
	constructor() {
		super(i18n.t('sync.cancelled'))
		this.name = 'SyncCancelledError'
	}
}

export interface SyncStartResult {
	/** The scan reached a normal outcome, including a run with no tasks. */
	completed: boolean
	/** At least one task was dispatched, even if all of them failed. */
	ranTasks: boolean
	shouldReloadSettings: boolean
	/** Remote requests rejected by a rate limit may resume after this time. */
	rateLimitedUntil?: number
}

const REMOTE_RATE_LIMIT_COOLDOWN_MS = 60_000

export class NutstoreSync {
	remoteFs: IFileSystem
	localFS: IFileSystem
	scope = new SyncScope()
	private cancelled = false
	get isCancelled() {
		return this.cancelled || this.options.signal?.aborted === true
	}
	set isCancelled(value: boolean) {
		this.cancelled = value
	}
	private preparationProgressEnabled = false

	private emitPreparationProgress(progress: SyncPreparationProgress): void {
		if (this.preparationProgressEnabled && !this.isCancelled) {
			emitSyncPreparationProgress(progress)
		}
	}

	private throwIfCancelled(): void {
		if (this.isCancelled) {
			throw new SyncCancelledError()
		}
	}

	private subscriptions: Subscription[] = []
	private currentLogPrefix = '[[Sync]]'
	private currentLogger: SyncLogger = createSyncLogger(this.currentLogPrefix)

	constructor(
		private plugin: NutstorePlugin,
		private options: {
			vault: Vault
			token: string
			remoteAccountId: string
			remoteBaseDir: string
			webdav: WebDAVClient
			signal?: AbortSignal
			/** Per-run selection, never written to plugin settings. */
			conflictStrategy?: ConflictStrategy
		},
	) {
		this.options = Object.freeze(this.options)
		const filterRules = computeEffectiveFilterRules(plugin)
		this.remoteFs = new NutstoreFileSystem({
			...this.options,
			settings: plugin.settings,
			filterRules,
			onTraversalProgress: (traversal) => {
				this.emitPreparationProgress({
					phase:
						traversal.phase === 'complete' ? 'analyzing' : 'traversingRemote',
					traversal,
				})
			},
			throwIfCancelled: () => this.throwIfCancelled(),
		})
		this.localFS = new LocalVaultFileSystem({
			vault: this.options.vault,
			syncRecord: new SyncRecord(
				getDBKey(this.vault.getName(), this.remoteBaseDir),
				syncRecordKV,
			),
			filterRules,
			settings: plugin.settings,
		})
		this.subscriptions.push(
			onCancelSync().subscribe(() => {
				this.isCancelled = true
			}),
		)
	}

	async start({
		mode,
		syncPolicy = this.localSettings.syncPolicy,
	}: {
		mode: SyncStartMode
		syncPolicy?: SyncPolicy
	}): Promise<SyncStartResult> {
		this.currentLogPrefix = formatSyncLogPrefix({
			mode,
			policy: syncPolicy,
		})
		this.currentLogger = createSyncLogger(this.currentLogPrefix)
		const showNotice = mode === SyncStartMode.MANUAL_SYNC
		// Every run starts here, so each later outcome event closes a started run.
		emitPreparingSync({ showNotice })
		try {
			this.throwIfCancelled()
			this.preparationProgressEnabled = showNotice

			const settings = this.settings
			const webdav = this.webdav
			const remoteBaseDir = stdRemotePath(this.options.remoteBaseDir)
			this.logger.info('[Sync] Endpoint:', {
				loginMode: settings.loginMode,
				dav: getNutstoreDavEndpoint(settings),
				nsdav: getNutstoreNsdavEndpoint(settings),
				remoteBaseDir,
			})
			const syncRecord = new SyncRecord(
				getDBKey(this.vault.getName(), this.remoteBaseDir),
				syncRecordKV,
			)
			const cacheService = new CacheService(this.plugin)

			// The probe is read-only, so an unavailable remote can fail before
			// spending time on the local snapshot.
			this.throwIfCancelled()
			this.emitPreparationProgress({ phase: 'checkingRemote' })
			let remoteBaseDirExists = await webdav.exists(remoteBaseDir)

			// Validate the entire local snapshot before creating directories or resetting records.
			const localStats = await this.localFS.walk()
			if (this.localFS instanceof LocalVaultFileSystem)
				this.scope = this.localFS.scope
			this.scope.observe(localStats)
			for (const issue of this.scope.issues) {
				this.logger.warn(
					'Subtree unavailable:',
					issue.path,
					issue.operation,
					issue.cause,
				)
			}
			this.throwIfCancelled()

			if (!remoteBaseDirExists) {
				// Preserve unknown/excluded history while retaining fresh-remote semantics.
				const records = await syncRecord.getRecords()
				await syncRecord.setRecords(
					new Map(
						[...records].filter(
							([path, record]) => !this.scope.allowsRecord(path, record),
						),
					),
				)
			}

			while (!remoteBaseDirExists) {
				if (this.isCancelled) {
					emitSyncCancelled()
					return {
						completed: false,
						ranTasks: false,
						shouldReloadSettings: false,
					}
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
							emitSyncCancelled()
							return {
								completed: false,
								ranTasks: false,
								shouldReloadSettings: false,
							}
						}
						remoteBaseDirExists = await webdav.exists(remoteBaseDir)
					} else {
						throw e
					}
				}
			}

			this.emitPreparationProgress({ phase: 'loadingState' })
			await cacheService.restoreRemoteTraversalCacheIfMissing(this.logger)
			const decider = (() => {
				switch (syncPolicy) {
					case SyncPolicy.SendOnly:
						return new SendOnlySyncDecider(this, syncRecord, localStats)
					case SyncPolicy.SendOnlyOverrideChanges:
						return new SendOnlyOverrideChangesSyncDecider(
							this,
							syncRecord,
							localStats,
						)
					case SyncPolicy.ReceiveOnly:
						return new ReceiveOnlySyncDecider(this, syncRecord, localStats)
					case SyncPolicy.ReceiveOnlyRevertLocalChanges:
						return new ReceiveOnlyRevertLocalChangesSyncDecider(
							this,
							syncRecord,
							localStats,
						)
					case SyncPolicy.TwoWay:
					default:
						return new TwoWaySyncDecider(this, syncRecord, localStats)
				}
			})()
			this.emitPreparationProgress({ phase: 'analyzing' })
			const tasks = (await decider.decide()).filter((task) =>
				this.scope.allowsTask(task),
			)
			if (!this.isCancelled) {
				this.emitPreparationProgress({ phase: 'savingCache' })
				await cacheService.saveRemoteTraversalCache(
					this.logger,
					() => this.isCancelled,
				)
			}
			this.throwIfCancelled()

			this.logger.info('[Sync] Decision:', {
				push: tasks.filter((t) => t instanceof PushTask).length,
				pull: tasks.filter((t) => t instanceof PullTask).length,
				conflict: tasks.filter((t) => t instanceof ConflictResolveTask).length,
				mkdirRemote: tasks.filter((t) => t instanceof MkdirRemoteTask).length,
				mkdirLocal: tasks.filter((t) => t instanceof MkdirLocalTask).length,
				removeLocal: tasks.filter((t) => t instanceof RemoveLocalTask).length,
				removeRemote: tasks.filter((t) => t instanceof RemoveRemoteTask).length,
				noop: tasks.filter((t) => t instanceof NoopTask).length,
				skipped: tasks.filter((t) => t instanceof SkippedTask).length,
				total: tasks.length,
			})

			if (tasks.length === 0) {
				emitEndSync({
					showNotice,
					failedCount: 0,
					scanIssues: this.scope.issues,
				})
				return {
					completed: true,
					ranTasks: false,
					shouldReloadSettings: false,
				}
			}

			const noopTasks = tasks.filter((t) => t instanceof NoopTask)
			const skippedTasks = tasks.filter((t) => t instanceof SkippedTask)
			let confirmedTasks = tasks.filter(
				(t) => !(t instanceof NoopTask || t instanceof SkippedTask),
			)

			const firstTaskIdxNeedingConfirmation = confirmedTasks.findIndex(
				(t) => !(t instanceof CleanRecordTask),
			)

			if (this.isCancelled) {
				emitSyncCancelled()
				return {
					completed: false,
					ranTasks: false,
					shouldReloadSettings: false,
				}
			}

			if (
				showNotice &&
				settings.confirmBeforeSync &&
				firstTaskIdxNeedingConfirmation > -1
			) {
				this.plugin.sync.progress.closeProgressModal()
				const confirmExec = await closeModalOnAbort(
					new TaskListConfirmModal(this.app, confirmedTasks),
					this.options.signal,
				).openAndWait()
				if (confirmExec.confirm) {
					confirmedTasks = confirmExec.tasks
					this.plugin.sync.progress.showProgressModal()
				} else {
					emitSyncCancelled()
					return {
						completed: false,
						ranTasks: false,
						shouldReloadSettings: false,
					}
				}
			}

			// Check for RemoveLocalTask during auto-sync and ask for confirmation
			if (
				mode === SyncStartMode.AUTO_SYNC &&
				settings.confirmBeforeDeleteInAutoSync
			) {
				const removeLocalTasks = confirmedTasks.filter(
					(t) => t instanceof RemoveLocalTask,
				)
				if (removeLocalTasks.length > 0) {
					new Notice(i18n.t('deleteConfirm.warningNotice'), 3000)
					const { tasksToDelete, tasksToReupload } = await closeModalOnAbort(
						new DeleteConfirmModal(this.app, removeLocalTasks),
						this.options.signal,
					).openAndWait()

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
							this.logger.error(e)
							// Directory doesn't exist, create mkdir task
							// No need to check parent's parent since createDirectory uses recursive: true
							const mkdirTask = new MkdirRemoteTask({
								vault: this.vault,
								webdav: webdav,
								remoteBaseDir: this.remoteBaseDir,
								remotePath: parentRemotePath,
								localPath: parentLocalPath,
								syncRecord: syncRecord,
								logger: this.logger,
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
			].filter((task) => this.scope.allowsTask(task))

			if (confirmedTasks.length > 500 && Platform.isDesktopApp) {
				new Notice(i18n.t('sync.suggestUseClientForManyTasks'), 5000)
			}

			const totalDisplayableTasks = optimizedTasks.filter(
				(t) => !(t instanceof NoopTask || t instanceof CleanRecordTask),
			)

			// Use scan metadata without reading file contents into mobile memory.
			const largeLocalPaths = new Set(
				Platform.isMobile
					? localStats
							.filter(
								({ stat }) =>
									!stat.isDir && (stat.size ?? 0) > 20 * 1024 * 1024,
							)
							.map(({ stat }) => stat.path)
					: [],
			)

			// Emit start sync event after all confirmations are done
			emitStartSync({ showNotice })
			const progress = {
				total: totalDisplayableTasks.length,
				completedCount: 0,
			}
			if (progress.total > 0) {
				emitSyncProgress({
					...progress,
					running: null,
					hasLargeUploads: totalDisplayableTasks.some(
						(task) =>
							task instanceof PushTask && largeLocalPaths.has(task.localPath),
					),
				})
			}
			const chunkSize = 200
			const taskChunks = chunk(optimizedTasks, chunkSize)
			const allTasksResult: TaskResult[] = []
			let shouldReloadSettings = false
			const updateMtimeProgress: UpdateMtimeProgress = {
				total: countRecordUpdateOperations(optimizedTasks),
				completed: 0,
			}

			for (const taskChunk of taskChunks) {
				const chunkResult = await this.execTasks(taskChunk, progress)
				allTasksResult.push(...chunkResult)
				shouldReloadSettings ||= taskChunk.some((task, index) =>
					this.didTaskReloadPluginSettings(task, chunkResult[index]),
				)
				await this.updateMtimeInRecord(
					taskChunk,
					chunkResult,
					updateMtimeProgress,
				)

				if (this.isCancelled) {
					break
				}
			}

			if (this.isCancelled) {
				emitSyncCancelled()
				return {
					completed: false,
					ranTasks: false,
					shouldReloadSettings: false,
				}
			}

			const failedCount = allTasksResult.filter((r) => !r.success).length
			this.logger.info(
				`[Sync] Completed: ${allTasksResult.length - failedCount} success, ${failedCount} failed`,
			)
			if (failedCount > 0) {
				this.logger.debug(
					'[Sync] Failed tasks',
					allTasksResult.flatMap((result, index) =>
						result.success
							? []
							: [
									{
										path: optimizedTasks[index].localPath,
										error: describeSyncError(result.error),
									},
								],
					),
				)
			}

			emitEndSync({ failedCount, showNotice, scanIssues: this.scope.issues })
			return { completed: true, ranTasks: true, shouldReloadSettings }
		} catch (error) {
			const rateLimitedUntil = is503Error(error)
				? Date.now() + REMOTE_RATE_LIMIT_COOLDOWN_MS
				: undefined
			if (
				this.isCancelled ||
				error instanceof SyncCancelledError ||
				isAbortError(error)
			) {
				emitSyncCancelled()
				this.logger.info('Sync cancelled')
			} else {
				emitSyncError(error as Error)
				this.logger.error('Sync error:', error)
			}
			return {
				completed: false,
				ranTasks: false,
				shouldReloadSettings: false,
				rateLimitedUntil,
			}
		} finally {
			this.preparationProgressEnabled = false
			this.currentLogPrefix = '[[Sync]]'
			this.currentLogger = createSyncLogger(this.currentLogPrefix)
			this.subscriptions.forEach((sub) => sub.unsubscribe())
		}
	}

	private didTaskReloadPluginSettings(task: BaseTask, result?: TaskResult) {
		if (!result?.success || !this.isPluginSettingsPath(task.localPath)) {
			return false
		}

		if (task instanceof PullTask || task instanceof RemoveLocalTask) {
			return true
		}

		if (task instanceof ConflictResolveTask) {
			return [
				ConflictStrategy.NoConflictMerge,
				ConflictStrategy.Diff3,
				ConflictStrategy.ServerPriority,
			].includes(task.options.strategy)
		}

		return false
	}

	private isPluginSettingsPath(localPath: string) {
		const pluginDir = normalizePath(
			`${this.vault.configDir}/plugins/${this.plugin.manifest.id}`,
		)
		return (
			localPath === `${pluginDir}/data.json` ||
			localPath === `${pluginDir}/data.local.json`
		)
	}

	/** `progress` counts displayable tasks across chunks; advanced in place. */
	private async execTasks(
		tasks: BaseTask[],
		progress: { total: number; completedCount: number },
	) {
		const res: TaskResult[] = []
		// Filter out NoopTask and CleanRecordTask from total count for progress display
		const tasksToDisplay = tasks.filter(
			(t) => !(t instanceof NoopTask || t instanceof CleanRecordTask),
		)

		this.logger.debug(`Starting to execute sync tasks`, {
			totalTasks: tasks.length,
			displayedTasks: tasksToDisplay.length,
			totalDisplayableTasks: progress.total,
			alreadyCompleted: progress.completedCount,
		})

		for (let i = 0; i < tasks.length; ++i) {
			const task = tasks[i]
			if (this.isCancelled) {
				break
			}

			const isDisplayable = !(
				task instanceof NoopTask || task instanceof CleanRecordTask
			)

			this.logger.debug(
				`Executing task [${i + 1}/${tasks.length}] ${task.localPath}`,
				{
					taskName: getTaskName(task),
					taskPath: task.localPath,
				},
			)

			if (isDisplayable) emitSyncProgress({ ...progress, running: task })

			const taskResult = await this.executeWithRetry(task)

			this.logger.debug(
				`Task completed [${i + 1}/${tasks.length}] ${task.localPath}`,
				{
					taskName: getTaskName(task),
					taskPath: task.localPath,
					result: taskResult,
				},
			)

			res[i] = taskResult
			if (isDisplayable) {
				progress.completedCount++
				emitSyncProgress({
					...progress,
					running: null,
					finished: {
						task,
						success: taskResult.success,
						error: taskResult.success
							? undefined
							: describeSyncError(taskResult.error),
					},
				})
			}
		}

		const successCount = res.filter((r) => r.success).length
		this.logger.debug(`All tasks execution completed`, {
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
		let retryCount = 0
		while (true) {
			if (this.isCancelled) {
				return {
					success: false,
					error: new TaskError(i18n.t('sync.cancelled'), task),
				}
			}
			const taskResult = await task.exec()
			if (!taskResult.success && is503Error(taskResult.error)) {
				retryCount++
				this.logger.warn(
					`[Sync] 503 on ${task.localPath}, retry #${retryCount} in 60s`,
				)
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

	async updateMtimeInRecord(
		tasks: BaseTask[],
		results: TaskResult[],
		progress: UpdateMtimeProgress,
	) {
		return updateMtimeInRecordUtil(
			this.plugin,
			this.vault,
			this.remoteBaseDir,
			tasks,
			results,
			10,
			this.logger,
			progress,
			this.scope,
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

	get conflictStrategy() {
		return this.options.conflictStrategy ?? this.settings.conflictStrategy
	}

	get localSettings() {
		return this.plugin.localSettings
	}

	get logger() {
		return this.currentLogger
	}
}
