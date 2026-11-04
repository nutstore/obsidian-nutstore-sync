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

const { notice, modals, outcomes, outcomeModal } = vi.hoisted(() => {
	/** End-of-run detail popups, in the order they were created. */
	const outcomes: {
		kind: 'scanIssues' | 'failedTasks'
		items: readonly unknown[]
		modalEl: { isConnected: boolean }
		open: () => void
		update: (items: readonly unknown[]) => void
		close: () => void
	}[] = []
	const outcomeModal = (kind: 'scanIssues' | 'failedTasks') =>
		class {
			kind = kind
			modalEl = { isConnected: false }
			open = vi.fn(() => {
				this.modalEl.isConnected = true
			})
			update = vi.fn()
			close = vi.fn(() => {
				this.modalEl.isConnected = false
			})
			constructor(
				_app: unknown,
				public items: readonly unknown[],
			) {
				outcomes.push(this as never)
			}
		}
	return {
		notice: vi.fn(),
		modals: [] as { update: () => void; onClose: () => void }[],
		outcomes,
		outcomeModal,
	}
})

vi.mock('obsidian', () => ({
	Notice: class {
		constructor(message: string) {
			notice(message)
		}
	},
}))

vi.mock('~/components/ScanIssuesModal', () => ({
	default: outcomeModal('scanIssues'),
}))
vi.mock('~/components/FailedTasksModal', () => ({
	default: outcomeModal('failedTasks'),
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
const planned = (total: number, hasLargeUploads?: boolean) =>
	emitSyncProgress({ total, completedCount: 0, running: null, hasLargeUploads })
const started = (total: number, completedCount: number, task: BaseTask) =>
	emitSyncProgress({ total, completedCount, running: task })
const finished = (
	total: number,
	completedCount: number,
	result: CompletedTask,
) =>
	emitSyncProgress({ total, completedCount, running: null, finished: result })

let running = true
let active = true
let service: ProgressService
beforeEach(() => {
	running = true
	active = true
	modals.length = 0
	outcomes.length = 0
	service = new ProgressService({
		app: {},
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
		planned(2, true)
		started(2, 0, a)
		expect(service.run).toMatchObject({
			status: 'syncing',
			currentInFlight: true,
			current: { kind: 'upload', localPath: '笔记🌱/<a> & b.md' },
		})
		finished(2, 1, done(a))
		// Between tasks the last one stays on screen, but nothing is in flight.
		expect(service.run).toMatchObject({
			currentInFlight: false,
			current: { localPath: '笔记🌱/<a> & b.md' },
		})
		started(2, 1, b)
		finished(2, 2, done(b, false, '无法连接 <offline>'))
		emitEndSync({ showNotice: false, failedCount: 1, scanIssues: [scanIssue] })

		expect(service.run).toMatchObject({
			status: 'partialScan',
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
		finished(1, 1, done(task))
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

	it('records each finished task once, in completion order', () => {
		const tasks = ['a', 'b', 'c'].map((name) => push(`${name} 🌿.md`))
		emitPreparingSync({ showNotice: false })
		tasks.forEach((task, index) => {
			started(3, index, task)
			finished(3, index + 1, done(task))
		})
		expect(service.run?.completed.map((r) => r.localPath)).toEqual([
			'a 🌿.md',
			'b 🌿.md',
			'c 🌿.md',
		])
	})

	it('replaces the previous run when the next one starts, including its upload advice', () => {
		emitPreparingSync({ showNotice: false })
		planned(1, true)
		finished(1, 1, done(push('a.md')))
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
		planned(1, false)
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
		planned(2, true)
		started(2, 0, push('a.md'))
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
		started(1, 0, push('a.md'))
		finished(1, 1, done(push('a.md')))
		expect(service.run).toMatchObject({ status: 'error', completed: [] })
	})

	it('ignores an outcome that arrives without a started run', () => {
		emitPreparingSync({ showNotice: false })
		finished(1, 1, done(push('a.md'), false, 'x'))
		emitEndSync({ showNotice: false, failedCount: 1 })
		const last = service.run
		expect(last?.status).toBe('failedTasks')

		// A repeated end, or a failure before the next run began, keeps the last run.
		emitEndSync({ showNotice: false, failedCount: 0 })
		emitSyncError(new Error('Unavailable 暂不可用'))
		emitSyncCancelled()
		expect(service.run).toBe(last)
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

describe('progress service end-of-run outcome', () => {
	const scanIssue = (path: string) => ({
		path,
		operation: 'list' as const,
		cause: new Error('Unavailable 暂不可用🌿'),
	})
	const endWith = (
		showNotice: boolean,
		results: CompletedTask[],
		scanIssues: ReturnType<typeof scanIssue>[] = [],
	) => {
		emitPreparingSync({ showNotice })
		// The user hid the progress view while the run went on.
		if (showNotice) service.closeProgressModal()
		results.forEach((result, index) =>
			finished(results.length, index + 1, result),
		)
		const failedCount = results.filter((result) => !result.success).length
		emitEndSync({ showNotice, failedCount, scanIssues })
	}

	it('lists unreadable paths even after a silent run, refreshing one list', () => {
		endWith(false, [], [scanIssue('Notes 笔记🌱/Section')])
		expect(outcomes).toHaveLength(1)
		expect(outcomes[0]).toMatchObject({ kind: 'scanIssues' })
		expect(outcomes[0].items).toEqual([scanIssue('Notes 笔记🌱/Section')])

		endWith(false, [], [scanIssue('Archive/資料📘')])
		expect(outcomes).toHaveLength(1)
		expect(outcomes[0].update).toHaveBeenCalledWith([
			scanIssue('Archive/資料📘'),
		])

		outcomes[0].close()
		service.showScanIssues()
		expect(outcomes).toHaveLength(2)
	})

	it('shows the failed tasks of a manual run with their reasons', () => {
		endWith(true, [
			done(push('笔记🌱/a.md')),
			done(pull('Notes/章节 📘.md'), false, '无法连接 <offline>'),
		])
		expect(outcomes).toHaveLength(1)
		expect(outcomes[0]).toMatchObject({
			kind: 'failedTasks',
			items: [
				{
					kind: 'download',
					localPath: 'Notes/章节 📘.md',
					success: false,
					error: '无法连接 <offline>',
				},
			],
		})
		expect(notice).not.toHaveBeenCalled()
	})

	it('keeps silent runs quiet unless paths were left unread', () => {
		endWith(false, [done(push('a 🌿.md'), false, 'x')])
		endWith(false, [])
		expect(outcomes).toHaveLength(0)
		expect(notice).not.toHaveBeenCalled()
	})

	it('confirms a clean manual run with a notice', () => {
		endWith(true, [done(push('a 🌿.md'))])
		expect(outcomes).toHaveLength(0)
		expect(notice).toHaveBeenCalledOnce()
	})

	it('leaves the outcome to an open progress view', () => {
		emitPreparingSync({ showNotice: true })
		finished(1, 1, done(push('a 🌿.md'), false, 'x'))
		emitEndSync({
			showNotice: true,
			failedCount: 1,
			scanIssues: [scanIssue('Notes 笔记🌱')],
		})
		expect(outcomes).toHaveLength(0)
		expect(notice).not.toHaveBeenCalled()
	})

	it('closes its popups when the module stops', () => {
		endWith(false, [], [scanIssue('Notes 笔记🌱')])
		service.onunload()
		expect(outcomes[0].close).toHaveBeenCalled()
	})
})
