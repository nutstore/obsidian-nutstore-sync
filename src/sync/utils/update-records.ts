import type { SyncScope } from '../scope'
import { chunk, debounce } from 'es-toolkit/compat'
import { Platform, Vault } from 'obsidian'
import { emitSyncUpdateMtimeProgress } from '~/events'
import { syncRecordKV } from '~/storage'
import {
	getMaxHashBytes,
	getRecordContentHash,
	LARGE_HASH_SERIALIZE_BYTES,
	type SyncRecordModel,
} from '~/model/sync-record.model'
import { SyncRecord } from '~/storage/sync-record'
import type { SyncLogger } from '~/sync/log'
import MkdirsRemoteTask from '~/sync/tasks/mkdirs-remote.task'
import type {
	BaseTask,
	SyncReceipt,
	TaskResult,
} from '~/sync/tasks/task.interface'
import { computeBufferDigest } from '~/sync/utils/file-digest'
import { isMergeablePath } from '~/sync/utils/is-mergeable-path'
import { AsyncMutex } from '~/utils/async-lock'
import { getDBKey } from '~/utils/get-db-key'
import { isSameTime } from '~/utils/is-same-time'
import { isSub } from '~/utils/is-sub'
import { readLocalBinary } from '~/utils/local-vault-io'
import { statVaultItem } from '~/utils/stat-vault-item'
import RemoveRemoteRecursivelyTask from '../tasks/remove-remote-recursively.task'

type PreparedRecordUpdate =
	| {
			kind: 'move'
			fromLocalPath: string
			localPath: string
			nextRecord?: SyncRecordModel
	  }
	| {
			kind: 'removeRecursive'
			localPath: string
	  }
	| {
			kind: 'delete'
			localPath: string
	  }
	| {
			kind: 'set'
			localPath: string
			nextRecord: SyncRecordModel
	  }

async function computeFileDigest(
	vault: Vault,
	localPath: string,
	fileSize: number,
	largeFileHashMutex: AsyncMutex,
): Promise<{ base?: { key: string }; contentHash?: string }> {
	const shouldHash =
		isMergeablePath(localPath) || fileSize <= getMaxHashBytes(Platform.isMobile)
	if (!shouldHash) {
		return {}
	}
	const run = async () => {
		const buffer = await readLocalBinary(vault, localPath)
		return await computeBufferDigest(buffer, localPath)
	}
	return fileSize >= LARGE_HASH_SERIALIZE_BYTES
		? await largeFileHashMutex.runExclusive(run)
		: await run()
}

export interface UpdateMtimeProgress {
	total: number
	completed: number
}

export function countRecordUpdateOperations(tasks: BaseTask[]): number {
	return tasks.reduce(
		(total, task) =>
			total +
			(task instanceof MkdirsRemoteTask ? task.getAllPaths().length : 1),
		0,
	)
}

/**
 * Updates `SyncRecord` strictly from each task's witnessed `SyncReceipt`
 * (and local directory stats for `mkdir` tasks), never from a post-task remote re-walk.
 */
export async function updateMtimeInRecord(
	vault: Vault,
	remoteBaseDir: string,
	tasks: BaseTask[],
	results: TaskResult[],
	batch_size: number,
	logger: SyncLogger,
	progress: UpdateMtimeProgress,
	scope?: SyncScope,
	isCancelled?: () => boolean,
): Promise<void> {
	if (tasks.length === 0) {
		return
	}

	const operationCount = countRecordUpdateOperations(tasks)
	const tasksNeedingUpdate = tasks
		.map((task, idx) => ({ task, result: results[idx] }))
		.filter(
			(
				item,
			): item is {
				task: BaseTask
				result: Extract<TaskResult, { success: true }>
			} =>
				Boolean(
					item.result?.success &&
					!item.result.skipRecord &&
					(!scope || scope.allowsTask(item.task)),
				),
		)

	if (tasksNeedingUpdate.length === 0) {
		progress.completed += operationCount
		emitSyncUpdateMtimeProgress(progress.total, progress.completed)
		return
	}

	const expandedTasks: Array<{
		task: BaseTask
		localPath: string
		receipt?: SyncReceipt
	}> = []
	for (const { task, result } of tasksNeedingUpdate) {
		if (task instanceof MkdirsRemoteTask) {
			for (const pathInfo of task.getAllPaths()) {
				expandedTasks.push({
					task,
					localPath: pathInfo.localPath,
					receipt: result.receipt,
				})
			}
		} else {
			expandedTasks.push({
				task,
				localPath: task.localPath,
				receipt: result.receipt,
			})
		}
	}

	const syncRecord = new SyncRecord(
		getDBKey(vault.getName(), remoteBaseDir),
		syncRecordKV,
	)
	const records = await syncRecord.getRecords()
	const startAt = Date.now()

	const debouncedSetRecords = debounce(
		(nextRecords: Map<string, SyncRecordModel>) =>
			syncRecord.setRecords(nextRecords),
		3000,
		{
			trailing: true,
			leading: false,
		},
	)

	const largeFileHashMutex = new AsyncMutex()
	const taskChunks = chunk(expandedTasks, batch_size)
	progress.completed += operationCount - expandedTasks.length
	emitSyncUpdateMtimeProgress(progress.total, progress.completed)

	try {
		for (const taskChunk of taskChunks) {
			// Persist all already-witnessed receipts even after cancellation so
			// completed tasks are not re-evaluated as conflicts on the next sync.
			const cancelled = isCancelled?.() ?? false
			// Phase 1: prepare mutations using only witnessed receipts + local reads.
			const batch = taskChunk.map(
				async ({
					task,
					localPath,
					receipt,
				}): Promise<PreparedRecordUpdate | null> => {
					try {
						if (scope && !scope.allowsTask(task)) {
							return null
						}

						if (receipt?.kind === 'unverified') {
							if (receipt.movedFromLocalPath) {
								return {
									kind: 'delete',
									localPath: receipt.movedFromLocalPath,
								}
							}
							return null
						}

						if (receipt?.kind === 'deleted') {
							if (
								receipt.recursive ||
								task instanceof RemoveRemoteRecursivelyTask
							) {
								return {
									kind: 'removeRecursive',
									localPath,
								}
							}
							return {
								kind: 'delete',
								localPath,
							}
						}

						if (receipt?.kind === 'synced') {
							if (receipt.movedFromLocalPath) {
								const previousRecord = records.get(receipt.movedFromLocalPath)
								const localStat = receipt.local
								let base = receipt.base
								let contentHash =
									receipt.contentHash ??
									(previousRecord
										? getRecordContentHash(previousRecord)
										: undefined)

								if (!localStat.isDir && isMergeablePath(localPath)) {
									if (!base && previousRecord?.base) {
										base = previousRecord.base
										contentHash ??= base.key
									} else if (!base && !cancelled) {
										const currentLocal = await statVaultItem(vault, localPath)
										const unchangedSinceReceipt =
											currentLocal &&
											!currentLocal.isDir &&
											isSameTime(currentLocal.mtime, localStat.mtime) &&
											currentLocal.size === localStat.size
										if (unchangedSinceReceipt) {
											const digest = await computeFileDigest(
												vault,
												localPath,
												localStat.size,
												largeFileHashMutex,
											)
											base = digest.base
											contentHash = digest.contentHash
										}
									}
								} else if (!localStat.isDir && !contentHash && !cancelled) {
									const currentLocal = await statVaultItem(vault, localPath)
									const unchangedSinceReceipt =
										currentLocal &&
										!currentLocal.isDir &&
										isSameTime(currentLocal.mtime, localStat.mtime) &&
										currentLocal.size === localStat.size
									if (unchangedSinceReceipt) {
										const digest = await computeFileDigest(
											vault,
											localPath,
											localStat.size,
											largeFileHashMutex,
										)
										contentHash = digest.contentHash
									}
								}

								return {
									kind: 'move',
									fromLocalPath: receipt.movedFromLocalPath,
									localPath,
									nextRecord: {
										local: localStat,
										remote: receipt.remote,
										base,
										contentHash,
									},
								}
							}

							let base = receipt.base
							let contentHash = receipt.contentHash
							if (!receipt.local.isDir && !contentHash && !base && !cancelled) {
								const currentLocal = await statVaultItem(vault, localPath)
								const unchangedSinceReceipt =
									currentLocal &&
									!currentLocal.isDir &&
									isSameTime(currentLocal.mtime, receipt.local.mtime) &&
									currentLocal.size === receipt.local.size
								if (unchangedSinceReceipt) {
									const digest = await computeFileDigest(
										vault,
										localPath,
										receipt.local.size,
										largeFileHashMutex,
									)
									base = digest.base
									contentHash = digest.contentHash
								}
							}

							return {
								kind: 'set',
								localPath,
								nextRecord: {
									local: receipt.local,
									remote: receipt.remote,
									...(base ? { base } : {}),
									...(contentHash ? { contentHash } : {}),
								},
							}
						}

						// Directory creation tasks (`MkdirRemoteTask`, `MkdirsRemoteTask`, `MkdirLocalTask`)
						const local = await statVaultItem(vault, localPath)
						if (!local || !local.isDir) {
							return null
						}
						return {
							kind: 'set',
							localPath,
							nextRecord: {
								local,
								remote: {
									path: localPath,
									basename: local.basename,
									isDir: true,
									isDeleted: false,
									mtime: local.mtime,
								},
							},
						}
					} catch (e) {
						const normalizedError =
							e instanceof Error ? e : new Error(String(e))
						logger.error(
							'updateMtimeInRecord',
							{
								errorName: normalizedError.name,
								errorMsg: normalizedError.message,
							},
							task.toJSON(),
						)
						return null
					}
				},
			)

			// Phase 2: apply mutations synchronously in exact task execution order.
			const preparedUpdates = await Promise.all(batch)
			for (const update of preparedUpdates) {
				if (!update) continue
				switch (update.kind) {
					case 'move':
						records.delete(update.fromLocalPath)
						if (update.nextRecord) {
							records.set(update.localPath, update.nextRecord)
						}
						break
					case 'removeRecursive':
						for (const k of records.keys()) {
							if (isSub(update.localPath, k) && (!scope || scope.allows(k))) {
								records.delete(k)
							}
						}
						records.delete(update.localPath)
						break
					case 'delete':
						records.delete(update.localPath)
						break
					case 'set':
						records.set(update.localPath, update.nextRecord)
						break
				}
			}

			progress.completed += taskChunk.length
			emitSyncUpdateMtimeProgress(progress.total, progress.completed)
			void debouncedSetRecords(records)
		}
	} finally {
		await debouncedSetRecords.flush()
	}

	logger.debug(`Records saving completed`, {
		recordsSize: records.size,
		elapsedMs: Date.now() - startAt,
	})
}
