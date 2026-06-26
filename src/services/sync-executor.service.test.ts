import { beforeEach, describe, expect, it, vi } from 'vitest'

const { emitStopGcMock, startMock, nutstoreSyncCtor } = vi.hoisted(() => ({
	emitStopGcMock: vi.fn(),
	startMock: vi.fn(),
	nutstoreSyncCtor: vi.fn(),
}))

vi.mock('~/events', () => ({
	emitStopGc: emitStopGcMock,
}))

vi.mock('~/sync', () => ({
	SyncStartMode: {
		AUTO_SYNC: 'auto_sync',
		MANUAL_SYNC: 'manual_sync',
	},
	NutstoreSync: nutstoreSyncCtor.mockImplementation(() => ({
		start: startMock,
	})),
}))

import { SyncStartMode } from '~/sync'
import SyncExecutorService from './sync-executor.service'

function createPlugin(): any {
	return {
		isSyncing: false,
		isAccountConfigured: vi.fn(() => true),
		getToken: vi.fn(async () => 'token'),
		remoteBaseDir: '/remote',
		app: {
			vault: {
				getName: vi.fn(() => 'vault'),
			},
		},
		webDAVService: {
			createWebDAVClient: vi.fn(async () => ({ client: true })),
		},
		gcService: {
			isRunningNow: vi.fn(() => false),
			waitUntilIdle: vi.fn(async () => undefined),
			runBlobGc: vi.fn(async () => undefined),
		},
		settingsService: {
			scheduleReloadSettingsFromDisk: vi.fn(),
		},
	}
}

describe('SyncExecutorService', () => {
	beforeEach(() => {
		emitStopGcMock.mockReset()
		startMock.mockReset()
		nutstoreSyncCtor.mockClear()
	})

	it('delegates directly to NutstoreSync.start and returns its result', async () => {
		startMock.mockResolvedValue({
			ended: true,
			ranTasks: true,
			shouldReloadSettings: false,
		})
		const plugin = createPlugin()
		const service = new SyncExecutorService(plugin)

		await expect(
			service.executeSync({ mode: SyncStartMode.AUTO_SYNC }),
		).resolves.toBe(true)

		expect(nutstoreSyncCtor).toHaveBeenCalledTimes(1)
		expect(startMock).toHaveBeenCalledWith({ mode: SyncStartMode.AUTO_SYNC })
	})

	it('returns false without constructing sync when account is not configured', async () => {
		const plugin = {
			...createPlugin(),
			isAccountConfigured: vi.fn(() => false),
		} as never
		const service = new SyncExecutorService(plugin)

		await expect(
			service.executeSync({ mode: SyncStartMode.AUTO_SYNC }),
		).resolves.toBe(false)

		expect(nutstoreSyncCtor).not.toHaveBeenCalled()
		expect(startMock).not.toHaveBeenCalled()
	})

	it('returns false when sync is already running', async () => {
		const plugin = {
			...createPlugin(),
			isSyncing: true,
		} as never
		const service = new SyncExecutorService(plugin)

		await expect(
			service.executeSync({ mode: SyncStartMode.AUTO_SYNC }),
		).resolves.toBe(false)

		expect(nutstoreSyncCtor).not.toHaveBeenCalled()
		expect(startMock).not.toHaveBeenCalled()
	})

	it('stops gc and continues sync when gc is running', async () => {
		startMock.mockResolvedValue({
			ended: true,
			ranTasks: true,
			shouldReloadSettings: false,
		})
		const plugin: any = {
			...createPlugin(),
			gcService: {
				isRunningNow: vi.fn(() => true),
				waitUntilIdle: vi.fn(async () => undefined),
				runBlobGc: vi.fn(async () => undefined),
			},
		}
		const service = new SyncExecutorService(plugin)

		await expect(
			service.executeSync({ mode: SyncStartMode.AUTO_SYNC }),
		).resolves.toBe(true)

		expect(emitStopGcMock).toHaveBeenCalledTimes(1)
		expect(plugin.gcService.waitUntilIdle).toHaveBeenCalledTimes(1)
		expect(nutstoreSyncCtor).toHaveBeenCalledTimes(1)
		expect(startMock).toHaveBeenCalledWith({ mode: SyncStartMode.AUTO_SYNC })
	})

	it('returns true when sync completes without runnable tasks', async () => {
		startMock.mockResolvedValue({
			ended: true,
			ranTasks: false,
			shouldReloadSettings: false,
		})
		const plugin = createPlugin()
		const service = new SyncExecutorService(plugin)

		await expect(
			service.executeSync({ mode: SyncStartMode.AUTO_SYNC }),
		).resolves.toBe(true)
	})
})
