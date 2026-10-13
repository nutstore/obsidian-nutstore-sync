import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type NutstorePlugin from '~/index'
import { ModuleLifecycle } from '~/modules/lifecycle'
import ScheduledSyncService from './scheduled-sync.service'
import RealtimeSyncService from './realtime-sync.service'
import type SyncExecutorService from './sync-executor.service'

vi.mock('~/sync', () => ({ SyncStartMode: { AUTO_SYNC: 'auto' } }))

beforeEach(() => {
	vi.useFakeTimers()
	vi.stubGlobal('window', globalThis)
})
afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

function fixture(delay: number) {
	const executeSync = vi.fn(async () => true)
	const settings = {
		startupSyncDelaySeconds: delay,
		autoSyncIntervalSeconds: 30,
		realtimeSync: true,
	}
	const listeners = new Map<string, () => void>()
	const vault = {
		on: (event: string, callback: () => void) => {
			listeners.set(event, callback)
			return event
		},
		offref: (event: string) => listeners.delete(event),
	}
	const sync = {} as { lifecycle: ModuleLifecycle }
	const plugin = { settings, sync, app: { vault } } as unknown as NutstorePlugin
	const executor = { executeSync } as unknown as SyncExecutorService
	const scheduled = new ScheduledSyncService(plugin, executor)
	const realtime = new RealtimeSyncService(plugin, executor)
	sync.lifecycle = new ModuleLifecycle(
		() => {
			void scheduled.start()
			realtime.onload()
		},
		() => {
			scheduled.onunload()
			realtime.onunload()
		},
	)
	return {
		settings,
		scheduled,
		executeSync,
		lifecycle: sync.lifecycle,
		listeners,
	}
}

describe('synchronization triggers during module transitions', () => {
	it('does not leave startup, interval, debounce or vault subscriptions after disabling', async () => {
		const f = fixture(5)
		await f.lifecycle.update(true)
		f.listeners.get('modify')?.()
		await f.lifecycle.update(false)
		await vi.advanceTimersByTimeAsync(120_000)
		expect(f.executeSync).not.toHaveBeenCalled()
		expect(f.listeners.size).toBe(0)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('a startup sync completing after disabling cannot recreate its interval', async () => {
		const f = fixture(1)
		let finish!: (value: boolean) => void
		f.executeSync.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		await f.lifecycle.update(true)
		await vi.advanceTimersByTimeAsync(1_000)
		expect(f.executeSync).toHaveBeenCalledTimes(1)
		await f.lifecycle.update(false)
		finish(true)
		await vi.advanceTimersByTimeAsync(120_000)
		expect(f.executeSync).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	it('restores one set of triggers and does not reset timing on unrelated settings saves', async () => {
		const f = fixture(0)
		for (let i = 0; i < 3; i++) {
			await f.lifecycle.update(true)
			await f.lifecycle.update(false)
		}
		await f.lifecycle.update(true)
		await vi.advanceTimersByTimeAsync(15_000)
		await f.scheduled.updateInterval()
		await vi.advanceTimersByTimeAsync(15_000)
		expect(f.executeSync).toHaveBeenCalledTimes(1)
		expect(f.listeners.size).toBe(4)
		expect(vi.getTimerCount()).toBe(1)
	})
})
