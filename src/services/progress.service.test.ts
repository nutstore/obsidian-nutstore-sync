import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	emitCancelSync,
	emitEndSync,
	emitPreparingSync,
	emitStartSync,
	emitSyncCancelled,
	emitSyncError,
	emitSyncPreparationProgress,
	emitSyncProgress,
	type CompletedTask,
} from '~/events'
import type NutstorePlugin from '~/index'
import PullTask from '~/sync/tasks/pull.task'
import PushTask from '~/sync/tasks/push.task'
import SkippedTask, { SkipReason } from '~/sync/tasks/skipped.task'
import type { BaseTask, BaseTaskOptions } from '~/sync/tasks/task.interface'
import { ProgressService } from './progress.service'

const { notice, modals } = vi.hoisted(() => ({
	notice: vi.fn(),
	modals: [] as { update: () => void; onClose: () => void }[],
}))

vi.mock('obsidian', () => ({
	Notice: class {
		constructor(message: string) {
			notice(message)
		}
	},
}))

vi.mock('~/components/SyncProgressModal', () => ({
	default: class {
		open = vi.fn()
		close = vi.fn()
		update = vi.fn()
		constructor(
			_plugin: unknown,
			readonly onClose: () => void,
		) {
			modals.push(this as never)
		}
	},
}))

const options = (localPath: string) =>
	({ localPath, remotePath: localPath, remoteBaseDir: '/' }) as BaseTaskOptions
const push = (path: string) => new PushTask(options(path))
const pull = (path: string) => new PullTask({ ...options(path), remoteSize: 1 })
const skipped = (path: string) =>
	new SkippedTask({
		...options(path),
		reason: SkipReason.FileTooLarge,
		maxSize: 1,
		remoteSize: 2,
	})
const done = (
	task: BaseTask,
	success = true,
	error?: string,
): CompletedTask => ({ task, success, error })

let running = true
let active = true
let service: ProgressService
beforeEach(() => {
	running = true
	active = true
	modals.length = 0
	service = new ProgressService({
		sync: {
			executor: { isRunning: () => running },
			lifecycle: {
				get active() {
					return active
				},
			},
		},
	} as unknown as NutstorePlugin)
	service.onload()
})
afterEach(() => {
	service.onunload()
	notice.mockClear()
})

describe('progress service run snapshot', () => {
	it('has no run before the first sync and says so when asked to show it', () => {
		expect(service.run).toBeNull()
		service.showProgressModal()
		expect(notice).toHaveBeenCalledTimes(1)
		expect(modals).toHaveLength(0)
	})

	it('keeps the finished run, with failures and scan issues, available to reopen', () => {
		const a = push('笔记🌱/<a> & b.md')
		const b = pull('Notes/章节 📘.md')
		const scanIssue = {
			path: 'Notes 笔记🌱',
			operation: 'list' as const,
			cause: new Error('Unavailable 暂不可用🌿'),
		}
		emitPreparingSync({ showNotice: false })
		emitStartSync({ showNotice: false })
		emitSyncProgress(2, [], null, true)
		emitSyncProgress(2, [], a)
		expect(service.run).toMatchObject({
			status: 'syncing',
			currentInFlight: true,
			current: { kind: 'upload', localPath: '笔记🌱/<a> & b.md' },
		})
		emitSyncProgress(2, [done(a)], a)
		expect(service.run?.currentInFlight).toBe(false)
		emitSyncProgress(2, [done(a)], b)
		emitSyncProgress(2, [done(a), done(b, false, '无法连接 <offline>')], b)
		emitEndSync({ showNotice: false, failedCount: 1, scanIssues: [scanIssue] })

		expect(service.run).toMatchObject({
			status: 'warning',
			total: 2,
			failedCount: 1,
			scanIssues: [scanIssue],
			hasLargeUploads: true,
			currentInFlight: false,
			completed: [
				{ kind: 'upload', localPath: '笔记🌱/<a> & b.md', success: true },
				{
					kind: 'download',
					localPath: 'Notes/章节 📘.md',
					success: false,
					error: '无法连接 <offline>',
				},
			],
		})
		expect(service.run?.endedAt).toBeGreaterThanOrEqual(service.run!.startedAt)

		// Nothing is running now, yet the outcome can still be opened.
		running = false
		service.showProgressModal()
		expect(notice).not.toHaveBeenCalled()
		expect(modals).toHaveLength(1)
		expect(service.hasVisibleSyncModal()).toBe(true)
	})

	it('retains only descriptors, never the tasks themselves', () => {
		const task = skipped('Notes/Large 大文件.bin')
		emitPreparingSync({ showNotice: false })
		emitSyncProgress(1, [done(task)], task)
		const record = service.run!.completed[0]
		expect(record).toEqual({
			kind: 'skip',
			skipReason: SkipReason.FileTooLarge,
			localPath: 'Notes/Large 大文件.bin',
			success: true,
			error: undefined,
		})
		expect(JSON.stringify(service.run)).not.toContain('remoteBaseDir')
	})

	it('appends only new completions as the shared list grows', () => {
		const tasks = ['a', 'b', 'c'].map((name) => push(`${name} 🌿.md`))
		const completed: CompletedTask[] = []
		emitPreparingSync({ showNotice: false })
		for (const task of tasks) {
			emitSyncProgress(3, completed, task)
			completed.push(done(task))
			emitSyncProgress(3, completed, task)
		}
		expect(service.run?.completed.map((r) => r.localPath)).toEqual([
			'a 🌿.md',
			'b 🌿.md',
			'c 🌿.md',
		])
	})

	it('replaces the previous run when the next one starts, including its upload advice', () => {
		emitPreparingSync({ showNotice: false })
		emitSyncProgress(1, [done(push('a.md'))], null, true)
		emitEndSync({ showNotice: false, failedCount: 0 })
		const previous = service.run
		expect(previous?.status).toBe('complete')

		emitPreparingSync({ showNotice: false })
		expect(service.run).toMatchObject({
			status: 'preparing',
			preparation: { phase: 'checkingRemote' },
			completed: [],
			failedCount: 0,
			scanIssues: [],
		})
		expect(service.run?.hasLargeUploads).toBeUndefined()
		expect(service.run?.endedAt).toBeUndefined()
		expect(previous?.completed).toHaveLength(1)
		emitSyncProgress(1, [], null, false)
		expect(service.run?.hasLargeUploads).toBe(false)
	})

	it('moves from preparing to syncing and keeps upload advice across updates', () => {
		emitPreparingSync({ showNotice: false })
		emitSyncPreparationProgress({ phase: 'analyzing' })
		expect(service.run).toMatchObject({
			status: 'preparing',
			preparation: { phase: 'analyzing' },
		})
		emitStartSync({ showNotice: false })
		expect(service.run).toMatchObject({ status: 'syncing', preparation: null })
		emitSyncProgress(2, [], null, true)
		emitSyncProgress(2, [], null)
		expect(service.run?.hasLargeUploads).toBe(true)
	})

	it('shows the progress view on a manual run and stays hidden on a silent one', () => {
		emitPreparingSync({ showNotice: false })
		expect(modals).toHaveLength(0)
		emitPreparingSync({ showNotice: true })
		expect(modals).toHaveLength(1)
	})

	it('does not open the view after the module stopped', () => {
		active = false
		emitPreparingSync({ showNotice: true })
		expect(modals).toHaveLength(0)
	})

	it('waits for cancellation to be acknowledged and ignores a second request', () => {
		emitPreparingSync({ showNotice: false })
		emitCancelSync()
		expect(service.run?.status).toBe('cancelling')
		emitSyncPreparationProgress({ phase: 'loadingState' })
		emitStartSync({ showNotice: false })
		expect(service.run?.status).toBe('cancelling')
		emitCancelSync()
		expect(service.run?.status).toBe('cancelling')
		emitSyncCancelled()
		expect(service.run?.status).toBe('cancelled')
		emitPreparingSync({ showNotice: false })
		expect(service.run?.status).toBe('preparing')
	})

	it('ignores a stop request when nothing is running', () => {
		emitCancelSync()
		expect(service.run).toBeNull()
		emitPreparingSync({ showNotice: false })
		emitEndSync({ showNotice: false, failedCount: 0 })
		emitCancelSync()
		expect(service.run?.status).toBe('complete')
		emitPreparingSync({ showNotice: false })
		running = false
		emitCancelSync()
		expect(service.run?.status).toBe('preparing')
	})

	it('keeps the failure that stopped a run so it can be read later', () => {
		const error = new Error('远端不可用 🌿 <503>')
		emitPreparingSync({ showNotice: false })
		emitSyncError(error)
		expect(service.run).toMatchObject({ status: 'error', error })
		expect(service.run?.preparation).toBeNull()
		// Late progress from the stopped run cannot revive it.
		emitSyncPreparationProgress({ phase: 'analyzing' })
		emitSyncProgress(1, [], push('a.md'))
		expect(service.run).toMatchObject({ status: 'error', completed: [] })
	})

	it('records a run that ended without a preparing step as the latest run', () => {
		emitPreparingSync({ showNotice: false })
		emitSyncProgress(1, [done(push('a.md'), false, 'x')], null)
		emitEndSync({ showNotice: false, failedCount: 1 })
		expect(service.run?.status).toBe('warning')

		emitEndSync({ showNotice: false, failedCount: 0 })
		expect(service.run).toMatchObject({
			status: 'complete',
			completed: [],
			failedCount: 0,
		})

		const error = new Error('Unavailable 暂不可用')
		emitSyncError(error)
		expect(service.run).toMatchObject({ status: 'error', error })
	})

	it('refreshes an open view on every change and drops it when closed', () => {
		emitPreparingSync({ showNotice: true })
		const modal = modals[0]
		service.updateModal.flush()
		modal.update = vi.fn()
		emitSyncPreparationProgress({ phase: 'analyzing' })
		service.updateModal.flush()
		expect(modal.update).toHaveBeenCalledTimes(1)
		modal.onClose()
		expect(service.hasVisibleSyncModal()).toBe(false)
		service.showProgressModal()
		expect(modals).toHaveLength(2)
	})
})
