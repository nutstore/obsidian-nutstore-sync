import { beforeEach, describe, expect, it, vi } from 'vitest'

const { startMock, nutstoreSyncCtor } = vi.hoisted(() => ({
	startMock: vi.fn(),
	nutstoreSyncCtor: vi.fn(),
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
	}
}

describe('SyncExecutorService', () => {
	beforeEach(() => {
		startMock.mockReset()
		nutstoreSyncCtor.mockClear()
	})

	it('delegates directly to NutstoreSync.start and returns its result', async () => {
		startMock.mockResolvedValue(true)
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
})
