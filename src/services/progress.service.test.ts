import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emitEndSync, emitPreparingSync, emitSyncProgress } from '../events'
import { ProgressService } from './progress.service'

const modal = vi.hoisted(() => ({
	open: vi.fn(),
	close: vi.fn(),
	update: vi.fn(),
}))

const resultModal = vi.hoisted(() => ({
	open: vi.fn(),
	close: vi.fn(),
}))

vi.mock('../components/SyncProgressModal', () => ({
	default: class {
		open = modal.open
		close = modal.close
		update = modal.update
	},
}))

vi.mock('../components/SyncResultModal', () => ({
	default: class {
		open = resultModal.open
		close = resultModal.close
	},
}))

vi.mock('obsidian', () => ({
	Notice: class {},
}))

describe('ProgressService completion', () => {
	let service: ProgressService

	beforeEach(() => {
		vi.clearAllMocks()
		service = new ProgressService({ isSyncing: true } as never)
		service.onload()
	})

	afterEach(() => {
		service.onunload()
	})

	it('replaces visible zero-task progress with a success result', () => {
		emitPreparingSync({ showNotice: true })
		service.showProgressModal()

		emitEndSync({ showNotice: true, failedCount: 0 })

		expect(modal.open).toHaveBeenCalledOnce()
		expect(modal.close).toHaveBeenCalledOnce()
		expect(resultModal.open).toHaveBeenCalledOnce()
	})

	it('replaces visible completed task progress with a success result', () => {
		emitPreparingSync({ showNotice: true })
		service.showProgressModal()
		emitSyncProgress(2, [], null)

		emitEndSync({ showNotice: true, failedCount: 0 })

		expect(modal.close).toHaveBeenCalledOnce()
		expect(resultModal.open).toHaveBeenCalledOnce()
	})

	it('does not show a result after progress was hidden', () => {
		emitPreparingSync({ showNotice: true })
		service.showProgressModal()
		service.closeProgressModal()

		emitEndSync({ showNotice: true, failedCount: 0 })

		expect(resultModal.open).not.toHaveBeenCalled()
	})

	it('shows a result when hidden progress was opened again', () => {
		emitPreparingSync({ showNotice: true })
		service.showProgressModal()
		service.closeProgressModal()
		service.showProgressModal()

		emitEndSync({ showNotice: true, failedCount: 0 })

		expect(resultModal.open).toHaveBeenCalledOnce()
	})

	it('keeps failed completion in the progress modal with its failure count', async () => {
		emitPreparingSync({ showNotice: true })
		service.showProgressModal()

		emitEndSync({ showNotice: true, failedCount: 2 })

		expect(service.syncFailedCount).toBe(2)
		await vi.waitFor(() => expect(modal.update).toHaveBeenCalled())
		expect(modal.close).not.toHaveBeenCalled()
		expect(resultModal.open).not.toHaveBeenCalled()
	})
})
