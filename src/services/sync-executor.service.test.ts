import { beforeEach, describe, expect, it, vi } from 'vitest'
import logger from '~/utils/logger'

const { emitStopGcMock, emitSyncErrorMock, startMock, nutstoreSyncCtor } =
	vi.hoisted(() => ({
		emitStopGcMock: vi.fn(),
		emitSyncErrorMock: vi.fn(),
		startMock: vi.fn(),
		nutstoreSyncCtor: vi.fn(),
	}))

vi.mock('~/events', () => ({
	emitStopGc: emitStopGcMock,
	emitSyncError: emitSyncErrorMock,
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
import type { SyncPolicy } from '~/settings'
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
		settings: {
			loginMode: 'sso',
			syncMode: 'loose',
			realtimeSync: true,
			autoSyncIntervalSeconds: 300,
			startupSyncDelaySeconds: 10,
			confirmBeforeSync: false,
			confirmBeforeDeleteInAutoSync: true,
			configDirSyncMode: 'bookmarks',
		},
		localSettings: {
			syncPolicy: 'two-way',
		},
		settingsService: {
			scheduleReloadSettingsFromDisk: vi.fn(),
		},
	}
}

describe('SyncExecutorService', () => {
	beforeEach(() => {
		emitStopGcMock.mockReset()
		emitSyncErrorMock.mockReset()
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
		expect(startMock).toHaveBeenCalledWith({
			mode: SyncStartMode.AUTO_SYNC,
			syncPolicy: 'two-way',
		})
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
		expect(startMock).toHaveBeenCalledWith({
			mode: SyncStartMode.AUTO_SYNC,
			syncPolicy: 'two-way',
		})
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

	it('uses a supplied policy for one sync without changing the saved default', async () => {
		startMock.mockResolvedValue({
			ended: true,
			ranTasks: true,
			shouldReloadSettings: false,
		})
		const plugin = createPlugin()
		const service = new SyncExecutorService(plugin)

		await service.executeSync({
			mode: SyncStartMode.MANUAL_SYNC,
			syncPolicy: 'receive-only' as SyncPolicy,
		})

		expect(startMock).toHaveBeenCalledWith({
			mode: SyncStartMode.MANUAL_SYNC,
			syncPolicy: 'receive-only',
		})
		expect(plugin.localSettings.syncPolicy).toBe('two-way')
	})

	it('logs sync trigger mode and policy before starting', async () => {
		startMock.mockResolvedValue({
			ended: true,
			ranTasks: true,
			shouldReloadSettings: false,
		})
		const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger)
		const plugin = createPlugin()
		const service = new SyncExecutorService(plugin)

		await service.executeSync({ mode: SyncStartMode.MANUAL_SYNC })

		expect(infoSpy).toHaveBeenCalledWith('Sync starting with settings:', {
			triggerMode: 'Manual',
			syncPolicy: 'TwoWay',
			loginMode: 'sso',
			remoteBaseDir: '/remote',
			syncMode: 'loose',
			realtimeSync: true,
			autoSyncIntervalSeconds: 300,
			startupSyncDelaySeconds: 10,
			confirmBeforeSync: false,
			confirmBeforeDeleteInAutoSync: true,
			configDirSyncMode: 'bookmarks',
		})
	})
})
