import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Vault } from 'obsidian'
import type { WebDAVClient } from 'webdav'
import type { StatModel } from '~/model/stat.model'
import { syncRecordKV } from '~/storage'
import { SyncRecord } from '~/storage/sync-record'
import { SyncScope } from '~/sync/scope'
import CleanRecordTask from '~/sync/tasks/clean-record.task'
import { optimizeTasksForExecution } from '~/sync/utils/optimize-tasks'
import { clearAllPluginStorage } from '@test/harness/memory-storage'

function makeStat(path: string): StatModel {
	return {
		path,
		basename: path.split('/').pop() ?? path,
		isDir: false,
		isDeleted: false,
		mtime: 1000,
		size: 32,
	}
}

describe('CleanRecordTask batching and SyncRecord.batchDelete', () => {
	beforeEach(async () => {
		await clearAllPluginStorage()
	})

	it('merges CleanRecordTask entries into one task and deletes all orphaned records in a single IDB write', async () => {
		const syncRecord = new SyncRecord('test-clean-batch', syncRecordKV)
		const keepPath = '保留目录 Keep 🌱/重要笔记.md'
		const orphanPaths = [
			'归档 Archive 📘/已删记录-1.md',
			'归档 Archive 📘/已删记录-2🌱.md',
			'临时 Temp/条目-3.md',
		]
		const initial = new Map(
			[keepPath, ...orphanPaths].map((p) => {
				const stat = makeStat(p)
				return [p, { local: stat, remote: stat }]
			}),
		)
		await syncRecord.setRecords(initial)

		const getSpy = vi.spyOn(syncRecordKV, 'get')
		const setSpy = vi.spyOn(syncRecordKV, 'set')

		const common = {
			vault: {} as Vault,
			webdav: {} as WebDAVClient,
			remoteBaseDir: '/Vault/',
			syncRecord,
			logger: { info() {}, debug() {}, warn() {}, error() {} },
		}

		const tasks = orphanPaths.map(
			(p) =>
				new CleanRecordTask({
					...common,
					localPath: p,
					remotePath: p,
				}),
		)
		const optimized = optimizeTasksForExecution(tasks)
		expect(optimized).toHaveLength(1)
		expect(optimized[0]).toBeInstanceOf(CleanRecordTask)

		const result = await optimized[0].exec()
		expect(result).toEqual({ success: true, skipRecord: true })
		expect(getSpy).toHaveBeenCalledTimes(1)
		expect(setSpy).toHaveBeenCalledTimes(1)

		const remaining = await syncRecord.getRecords()
		expect([...remaining.keys()]).toEqual([keepPath])
	})

	it('rejects a merged CleanRecordTask in SyncScope when any target path is protected', () => {
		const syncRecord = new SyncRecord('test-clean-scope', syncRecordKV)
		const common = {
			vault: {} as Vault,
			webdav: {} as WebDAVClient,
			remoteBaseDir: '/Vault/',
			syncRecord,
			logger: { info() {}, debug() {}, warn() {}, error() {} },
		}

		const safe = new CleanRecordTask({
			...common,
			localPath: 'healthy/安全记录🌱.md',
			remotePath: 'healthy/安全记录🌱.md',
		})
		const protectedTask = new CleanRecordTask({
			...common,
			localPath: 'blocked/受保护记录📘.md',
			remotePath: 'blocked/受保护记录📘.md',
		})

		const scope = new SyncScope()
		scope.protect('blocked')

		const mergedAll = optimizeTasksForExecution([safe, protectedTask])
		expect(mergedAll).toHaveLength(1)
		expect(scope.allowsTask(mergedAll[0])).toBe(false)

		const filteredThenOptimized = optimizeTasksForExecution(
			[safe, protectedTask].filter((t) => scope.allowsTask(t)),
		)
		expect(filteredThenOptimized).toHaveLength(1)
		expect(scope.allowsTask(filteredThenOptimized[0])).toBe(true)
	})
})
