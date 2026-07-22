import { beforeEach, describe, expect, it, vi } from 'vitest'
import type NutstorePlugin from '../..'
import type { SyncLogger } from '../log'
import MkdirsRemoteTask from '../tasks/mkdirs-remote.task'
import type { BaseTask, TaskResult } from '../tasks/task.interface'
import {
	countRecordUpdateOperations,
	updateMtimeInRecord,
	type UpdateMtimeProgress,
} from './update-records'

const emitProgress = vi.hoisted(() => vi.fn())

vi.mock('~/events', () => ({
	emitSyncUpdateMtimeProgress: emitProgress,
}))

describe('updateMtimeInRecord global progress', () => {
	beforeEach(() => {
		emitProgress.mockReset()
	})

	it('keeps cumulative progress across English and Chinese task groups', async () => {
		const progress: UpdateMtimeProgress = { total: 2, completed: 0 }
		const plugin = {} as NutstorePlugin
		const vault = {} as never
		const logger = {} as SyncLogger
		const failedResult = { success: false } as TaskResult
		const englishTask = { localPath: 'notes/example.md' } as BaseTask
		const chineseTask = { localPath: '文档/示例.md' } as BaseTask

		await updateMtimeInRecord(
			plugin,
			vault,
			'/vault',
			[englishTask],
			[failedResult],
			10,
			logger,
			progress,
		)
		await updateMtimeInRecord(
			plugin,
			vault,
			'/vault',
			[chineseTask],
			[failedResult],
			10,
			logger,
			progress,
		)

		expect(emitProgress.mock.calls).toEqual([
			[2, 1],
			[2, 2],
		])
	})

	it('counts all paths represented by a merged directory task', () => {
		const task = new MkdirsRemoteTask({
			localPath: '文档/子目录',
			remotePath: '/vault/文档/子目录',
			additionalPaths: [{ localPath: 'notes', remotePath: '/vault/notes' }],
		} as never)

		expect(countRecordUpdateOperations([task])).toBe(2)
	})
})
