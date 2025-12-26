import { chunk, debounce, isNil } from 'lodash-es'
import { Vault } from 'obsidian'
import { emitSyncUpdateMtimeProgress } from '~/events'
import { NutstoreFileSystem } from '~/fs/nutstore'
import { syncRecordKV } from '~/storage'
import { blobStore } from '~/storage/blob'
import { SyncRecord } from '~/storage/sync-record'
import MkdirsRemoteTask from '~/sync/tasks/mkdirs-remote.task'
import type { BaseTask, TaskResult } from '~/sync/tasks/task.interface'
import { getSyncRecordNamespace } from '~/utils/get-sync-record-namespace'
import { isSub } from '~/utils/is-sub'
import logger from '~/utils/logger'
import { isMergeablePath } from '~/utils/mime/is-mergeable-path'
import { statVaultItem } from '~/utils/stat-vault-item'
import { stdRemotePath } from '~/utils/std-remote-path'
import type NutstorePlugin from '../..'
import RemoveRemoteRecursivelyTask from '../tasks/remove-remote-recursively.task'

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
): Promise<void> {
	if (tasks.length === 0) {
		return
	}
	// Filter out tasks that don't need record updates
	const tasksNeedingUpdate = tasks.filter((task, idx) => {
		return results[idx]?.success && !results[idx]?.skipRecord
	})

	if (tasksNeedingUpdate.length === 0) {
		return
	}

	const token = await plugin.getToken()
	const remoteFs = new NutstoreFileSystem({
		vault,
		token,
		remoteBaseDir: stdRemotePath(remoteBaseDir),
	})

	const latestRemoteEntities = await remoteFs.walk()
	const remoteEntityMap = new Map(
		latestRemoteEntities.map((e) => [e.stat.path, e]),
	)
	const syncRecord = new SyncRecord(
		getSyncRecordNamespace(vault.getName(), remoteBaseDir),
		syncRecordKV,
	)
	const records = await syncRecord.getRecords()
	const startAt = Date.now()
	let completedCount = 0
	let successfulTasksCount = 0

	const debouncedSetRecords = debounce(
		(records) => syncRecord.setRecords(records),
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
					records.delete(localPath)
					return
				}

				if (!local && !remote) {
					records.delete(localPath)
					return
				}
				if (!local || !remote) {
					return
				}
				// Calculate base for file content
				let base: { key: string } | undefined
				let baseKey: string | undefined
				if (!local.isDir) {
					const file = vault.getFileByPath(localPath)
					if (!file) {
						return
					}

					const buffer = await vault.readBinary(file)
					const isMergeable = isMergeablePath(file.path)
					if (!isMergeable) {
						baseKey = undefined
					} else {
						const { key } = await blobStore.store(buffer)
						baseKey = key
					}
				}
				base = isNil(baseKey) ? undefined : { key: baseKey }

				records.set(localPath, {
					remote: remote.stat,
					local,
					base,
				})
				successfulTasksCount++
			} catch (e) {
				logger.error(
					'updateMtimeInRecord',
					{
						errorName: e.name,
						errorMsg: e.message,
					},
					task.toJSON(),
				)
			} finally {
				completedCount++
			}
		})
		await Promise.all(batch)
		emitSyncUpdateMtimeProgress(tasksNeedingUpdate.length, completedCount)
		debouncedSetRecords(records)
	}

	await debouncedSetRecords.flush()

	logger.debug(`Records saving completed`, {
		recordsSize: records.size,
		elapsedMs: Date.now() - startAt,
	})
}
