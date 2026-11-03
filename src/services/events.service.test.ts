import { afterEach, describe, expect, it, vi } from 'vitest'
import { emitEndSync } from '~/events'
import type { ScanIssue } from '~/sync/scope'
import EventsService from './events.service'

const { notice, modals } = vi.hoisted(() => ({
	notice: vi.fn(),
	modals: [] as {
		issues: readonly ScanIssue[]
		connected: boolean
		open: () => void
		update: (issues: readonly ScanIssue[]) => void
		close: () => void
	}[],
}))

vi.mock('obsidian', () => ({
	Notice: class {
		constructor(message: string) {
			notice(message)
		}
	},
}))

vi.mock('~/components/ScanIssuesModal', () => ({
	default: class {
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
			public issues: readonly ScanIssue[],
		) {
			modals.push(this as never)
		}
	},
}))

const issue = (path: string): ScanIssue => ({
	path,
	operation: 'list',
	cause: new Error('Unavailable 暂不可用🌿'),
})

function start(progressVisible = false) {
	const plugin = {
		app: {},
		toggleSyncUI: vi.fn(),
		sync: {
			status: { setLastSyncTime: vi.fn(), updateSyncStatus: vi.fn() },
			progress: { hasVisibleSyncModal: () => progressVisible },
		},
	}
	const service = new EventsService(plugin as never)
	service.onload()
	return { plugin, service }
}

afterEach(() => {
	notice.mockClear()
	modals.length = 0
})

describe('EventsService scan issues', () => {
	it('opens one modal listing the unreadable in-scope paths when sync ends', () => {
		const { plugin, service } = start()
		const issues = [issue('Notes 笔记🌱/Section'), issue('Archive/資料')]
		emitEndSync({ failedCount: 0, showNotice: false, scanIssues: issues })
		expect(modals).toHaveLength(1)
		expect(modals[0].issues).toEqual(issues)
		expect(modals[0].open).toHaveBeenCalledOnce()
		expect(plugin.sync.status.setLastSyncTime).toHaveBeenCalledWith(
			expect.any(Number),
			2,
		)
		service.onunload()
	})

	it('refreshes the open modal for a later sync and reopens after it closes', () => {
		const { service } = start()
		emitEndSync({ failedCount: 0, showNotice: false, scanIssues: [issue('a')] })
		emitEndSync({ failedCount: 0, showNotice: false, scanIssues: [issue('b')] })
		expect(modals).toHaveLength(1)
		expect(modals[0].update).toHaveBeenCalledWith([issue('b')])
		modals[0].close()
		emitEndSync({ failedCount: 0, showNotice: false, scanIssues: [issue('c')] })
		expect(modals).toHaveLength(2)
		service.onunload()
	})

	it('leaves the list to the progress modal button while that modal is visible', () => {
		const { service } = start(true)
		const issues = [issue('Notes 笔记🌱/Section')]
		emitEndSync({ failedCount: 0, showNotice: true, scanIssues: issues })
		expect(modals).toHaveLength(0)
		expect(notice).not.toHaveBeenCalled()
		service.showScanIssues(issues)
		expect(modals).toHaveLength(1)
		expect(modals[0].issues).toEqual(issues)
		service.showScanIssues([issue('b')])
		expect(modals).toHaveLength(1)
		expect(modals[0].update).toHaveBeenCalledWith([issue('b')])
		service.onunload()
	})

	it('stays silent about scanning when every path was readable', () => {
		const { service } = start()
		emitEndSync({ failedCount: 0, showNotice: true, scanIssues: [] })
		expect(modals).toHaveLength(0)
		expect(notice).toHaveBeenCalledOnce()
		service.onunload()
	})
})
