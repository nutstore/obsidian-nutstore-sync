import { describe, expect, it, vi } from 'vitest'
import { emitEndSync } from '~/events'
import type { ScanIssue } from '~/sync/scope'
import EventsService from './events.service'

vi.mock('obsidian', () => ({ Notice: class {} }))

const issue = (path: string): ScanIssue => ({
	path,
	operation: 'list',
	cause: new Error('Unavailable 暂不可用🌿'),
})

describe('EventsService sync end', () => {
	it('counts failed tasks and unreadable paths together in the status bar', () => {
		const plugin = {
			toggleSyncUI: vi.fn(),
			sync: {
				status: { setLastSyncTime: vi.fn(), updateSyncStatus: vi.fn() },
			},
		}
		const service = new EventsService(plugin as never)
		service.onload()
		emitEndSync({
			failedCount: 1,
			showNotice: false,
			scanIssues: [issue('Notes 笔记🌱/Section'), issue('Archive/資料📘')],
		})
		expect(plugin.toggleSyncUI).toHaveBeenCalledWith(false)
		expect(plugin.sync.status.setLastSyncTime).toHaveBeenCalledWith(
			expect.any(Number),
			3,
		)
		service.onunload()
	})
})
