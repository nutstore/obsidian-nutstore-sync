import { chunk, debounce, isNil } from 'lodash-es'
import { Vault } from 'obsidian'
import { emitSyncUpdateMtimeProgress } from '~/events'
import { NutstoreFileSystem } from '~/fs/nutstore'
import { syncRecordKV } from '~/storage'
import { blobStore } from '~/storage/blob'
import type { SyncRecordModel } from '~/model/sync-record.model'
import { SyncRecord } from '~/storage/sync-record'
import type { SyncLogger } from '~/sync/log'
import MkdirsRemoteTask from '~/sync/tasks/mkdirs-remote.task'
import type { BaseTask, TaskResult } from '~/sync/tasks/task.interface'
import { isMergeablePath } from '~/sync/utils/is-mergeable-path'
import { getDBKey } from '~/utils/get-db-key'
import { isSub } from '~/utils/is-sub'
import { readLocalBinary } from '~/utils/local-vault-io'
import { statVaultItem } from '~/utils/stat-vault-item'
import { stdRemotePath } from '~/utils/std-remote-path'
import type NutstorePlugin from '../..'
import RemoveRemoteRecursivelyTask from '../tasks/remove-remote-recursively.task'

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
): Promise<void> {
	if (tasks.length === 0) {
		return
	}
	const operationCount = countRecordUpdateOperations(tasks)
	// Filter out tasks that don't need record updates
	const tasksNeedingUpdate = tasks.filter((_task, idx) => {
		return results[idx]?.success && !results[idx]?.skipRecord
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

	const taskChunks = chunk(expandedTasks, batch_size)
	progress.completed += operationCount - expandedTasks.length
	emitSyncUpdateMtimeProgress(progress.total, progress.completed)

	for (const taskChunk of taskChunks) {
		const batch = taskChunk.map(async ({ task, localPath }) => {
			try {
				const remote = remoteEntityMap.get(localPath)
				const local = await statVaultItem(vault, localPath)

				if (task instanceof RemoveRemoteRecursivelyTask) {
					for (const k of records.keys()) {
						if (isSub(localPath, k)) {
							records.delete(k)
						}
					}
					if (!local || !remote) {
						records.delete(localPath)
						return
					}
				}

				if (!local && !remote) {
					records.delete(localPath)
					return
				}
				if (!local || !remote) {
					return
				}
				// Calculate base for file content
				const base: { key: string } | undefined = await (async () => {
					let baseKey: string | undefined
					if (!local.isDir && isMergeablePath(localPath)) {
						const buffer = await readLocalBinary(vault, localPath)
						const { key } = await blobStore.store(buffer)
						baseKey = key
					}
					return isNil(baseKey) ? undefined : { key: baseKey }
				})()

				records.set(localPath, {
					remote: remote.stat,
					local,
					base,
				})
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
			}
		})
		await Promise.all(batch)
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
