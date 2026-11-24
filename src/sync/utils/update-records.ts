import type { SyncScope } from '../scope'
import { chunk, debounce } from 'es-toolkit/compat'
import { Platform, Vault } from 'obsidian'
import { emitSyncUpdateMtimeProgress } from '~/events'
import { NutstoreFileSystem } from '~/fs/nutstore'
import { syncRecordKV } from '~/storage'
import { blobStore } from '~/storage/blob'
import {
	getMaxHashBytes,
	getRecordContentHash,
	LARGE_HASH_SERIALIZE_BYTES,
	type SyncRecordModel,
} from '~/model/sync-record.model'
import { SyncRecord } from '~/storage/sync-record'
import type { SyncLogger } from '~/sync/log'
import MkdirsRemoteTask from '~/sync/tasks/mkdirs-remote.task'
import MoveRemoteTask from '~/sync/tasks/move-remote.task'
import type { BaseTask, TaskResult } from '~/sync/tasks/task.interface'
import { isMergeablePath } from '~/sync/utils/is-mergeable-path'
import { AsyncMutex } from '~/utils/async-lock'
import { getDBKey } from '~/utils/get-db-key'
import { isSameTime } from '~/utils/is-same-time'
import { isSub } from '~/utils/is-sub'
import { readLocalBinary } from '~/utils/local-vault-io'
import { sha256Base64 } from '~/utils/sha256'
import { statVaultItem } from '~/utils/stat-vault-item'
import { stdRemotePath } from '~/utils/std-remote-path'
import type NutstorePlugin from '../..'
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
			nextRecord?: SyncRecordModel
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
	storeBase: boolean,
	largeFileHashMutex: AsyncMutex,
): Promise<{ base?: { key: string }; contentHash?: string }> {
	const shouldHash = storeBase || fileSize <= getMaxHashBytes(Platform.isMobile)
	if (!shouldHash) {
		return {}
	}
	const run = async () => {
		const buffer = await readLocalBinary(vault, localPath)
		if (storeBase) {
			const { key } = await blobStore.store(buffer)
			return { base: { key }, contentHash: key }
		}
		return { contentHash: await sha256Base64(buffer) }
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
 * 批量更新同步记录的工具函数
 */
export async function updateMtimeInRecord(
	plugin: NutstorePlugin,
	vault: Vault,
	remoteBaseDir: string,
	tasks: BaseTask[],
	results: TaskResult[],
	batch_size: number,
	logger: SyncLogger,
	progress: UpdateMtimeProgress,
	scope?: SyncScope,
): Promise<void> {
	if (tasks.length === 0) {
		return
	}
	const operationCount = countRecordUpdateOperations(tasks)
	// Filter out tasks that don't need record updates
	const tasksNeedingUpdate = tasks.filter((_task, idx) => {
		return (
			results[idx]?.success &&
			!results[idx]?.skipRecord &&
			(!scope || scope.allowsTask(_task))
		)
	})

	if (tasksNeedingUpdate.length === 0) {
		progress.completed += operationCount
		emitSyncUpdateMtimeProgress(progress.total, progress.completed)
		return
	}

	const token = await plugin.getToken()
	const remoteFs = new NutstoreFileSystem({
		settings: plugin.settings,
		vault,
		token,
		remoteAccountId: await plugin.getRemoteAccountId(),
		remoteBaseDir: stdRemotePath(remoteBaseDir),
	})

	const latestRemoteEntities = await remoteFs.walk()
	const remoteEntityMap = new Map(
		latestRemoteEntities.map((e) => [e.stat.path, e]),
	)
	const syncRecord = new SyncRecord(
		getDBKey(vault.getName(), remoteBaseDir),
		syncRecordKV,
	)
	const records = await syncRecord.getRecords()
	const startAt = Date.now()

	const debouncedSetRecords = debounce(
		(records: Map<string, SyncRecordModel>) => syncRecord.setRecords(records),
		3000,
		{
			trailing: true,
			leading: false,
		},
	)

	// Expand MkdirsRemoteTask into multiple update operations
	const expandedTasks: Array<{ task: BaseTask; localPath: string }> = []
	for (const task of tasksNeedingUpdate) {
		if (task instanceof MkdirsRemoteTask) {
			// Add main path and all additional paths
			const allPaths = task.getAllPaths()
			for (const pathInfo of allPaths) {
				expandedTasks.push({ task, localPath: pathInfo.localPath })
			}
		} else {
			expandedTasks.push({ task, localPath: task.localPath })
		}
	}

	const largeFileHashMutex = new AsyncMutex()
	const taskChunks = chunk(expandedTasks, batch_size)
	progress.completed += operationCount - expandedTasks.length
	emitSyncUpdateMtimeProgress(progress.total, progress.completed)

	for (const taskChunk of taskChunks) {
		// Phase 1: run read-only stat/hash I/O concurrently without mutating `records`.
		const batch = taskChunk.map(
			async ({ task, localPath }): Promise<PreparedRecordUpdate | null> => {
				try {
					if (scope && !scope.allowsTask(task)) {
						return null
					}
					const remote = remoteEntityMap.get(localPath)
					const local = await statVaultItem(vault, localPath)

					if (task instanceof MoveRemoteTask) {
						const previousRecord = records.get(task.fromLocalPath)
						if (!local || !remote) {
							return {
								kind: 'move',
								fromLocalPath: task.fromLocalPath,
								localPath,
							}
						}
						if (task.usedFallbackUpload) {
							// Fallback upload wrote current local bytes rather than moving old remote bytes.
							const digest = !local.isDir
								? await computeFileDigest(
										vault,
										localPath,
										local.size,
										isMergeablePath(localPath),
										largeFileHashMutex,
									)
								: {}
							return {
								kind: 'move',
								fromLocalPath: task.fromLocalPath,
								localPath,
								nextRecord: {
									remote: remote.stat,
									local,
									...digest,
								},
							}
						}

						// Server-side MOVE relocated the pre-existing remote bytes, which match
						// `expectedLocalStat` rather than any local edits made after planning.
						const expected = task.expectedLocalStat
						const editedDuringMove =
							!local.isDir &&
							expected !== undefined &&
							(!isSameTime(local.mtime, expected.mtime) ||
								local.size !== expected.size)
						const recordedLocal = editedDuringMove ? expected : local

						let base: { key: string } | undefined
						let contentHash = previousRecord
							? getRecordContentHash(previousRecord)
							: undefined
						if (!recordedLocal.isDir && isMergeablePath(localPath)) {
							if (previousRecord?.base) {
								base = previousRecord.base
								contentHash ??= base.key
							} else if (!editedDuringMove) {
								const digest = await computeFileDigest(
									vault,
									localPath,
									recordedLocal.size,
									true,
									largeFileHashMutex,
								)
								base = digest.base
								contentHash = digest.contentHash
							}
						} else if (
							!recordedLocal.isDir &&
							!contentHash &&
							!editedDuringMove
						) {
							const digest = await computeFileDigest(
								vault,
								localPath,
								recordedLocal.size,
								false,
								largeFileHashMutex,
							)
							contentHash = digest.contentHash
						}

						return {
							kind: 'move',
							fromLocalPath: task.fromLocalPath,
							localPath,
							nextRecord: {
								remote: remote.stat,
								local: recordedLocal,
								base,
								contentHash,
							},
						}
					}

					if (task instanceof RemoveRemoteRecursivelyTask) {
						if (!local || !remote) {
							return {
								kind: 'removeRecursive',
								localPath,
							}
						}
						const digest = !local.isDir
							? await computeFileDigest(
									vault,
									localPath,
									local.size,
									isMergeablePath(localPath),
									largeFileHashMutex,
								)
							: {}
						return {
							kind: 'removeRecursive',
							localPath,
							nextRecord: {
								remote: remote.stat,
								local,
								...digest,
							},
						}
					}

					if (!local && !remote) {
						return {
							kind: 'delete',
							localPath,
						}
					}
					if (!local || !remote) {
						return null
					}
					const digest = !local.isDir
						? await computeFileDigest(
								vault,
								localPath,
								local.size,
								isMergeablePath(localPath),
								largeFileHashMutex,
							)
						: {}

					return {
						kind: 'set',
						localPath,
						nextRecord: {
							remote: remote.stat,
							local,
							...digest,
						},
					}
				} catch (e) {
					const normalizedError = e instanceof Error ? e : new Error(String(e))
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
					if (update.nextRecord) {
						records.set(update.localPath, update.nextRecord)
					} else {
						records.delete(update.localPath)
					}
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

	await debouncedSetRecords.flush()

	logger.debug(`Records saving completed`, {
		recordsSize: records.size,
		elapsedMs: Date.now() - startAt,
	})
}
