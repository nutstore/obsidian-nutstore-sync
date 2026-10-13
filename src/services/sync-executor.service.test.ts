import { beforeEach, describe, expect, it, vi } from 'vitest'
import type NutstorePlugin from '~/index'
import { ModuleLifecycle } from '~/modules/lifecycle'
import { SyncStartMode } from '~/sync'
import SyncExecutorService from './sync-executor.service'

const { start, construct, notice } = vi.hoisted(() => ({
	start: vi.fn(),
	construct: vi.fn(),
	notice: vi.fn(),
}))
vi.mock('obsidian', () => ({
	Notice: class {
		constructor(message: string) {
			notice(message)
		}
	},
}))
vi.mock('~/sync', () => ({
	SyncStartMode: { AUTO_SYNC: 'auto', MANUAL_SYNC: 'manual' },
	NutstoreSync: class {
		constructor(...args: unknown[]) {
			construct(...args)
		}
		start = start
	},
}))
vi.mock('~/sync/log', () => ({
	getSyncPolicyLabel: () => 'two-way',
	getSyncTriggerLabel: () => 'auto',
}))
vi.mock('~/utils/config-dir-rules', () => ({
	getConfigDirPruningRule: () => undefined,
}))
vi.mock('~/utils/logger', () => ({
	default: { info: vi.fn(), error: vi.fn() },
}))

beforeEach(() => {
	vi.clearAllMocks()
	start.mockResolvedValue({ ended: true, shouldReloadSettings: false })
})

function fixture() {
	const runBlobGc = vi.fn(async () => ({ ok: true, deletedCount: 0 }))
	const getToken = vi.fn(async () => 'test-only-token')
	const plugin = {
		isSyncing: false,
		settings: { filterRules: { rules: [] } },
		localSettings: { syncPolicy: 'two-way' },
		remoteBaseDir: 'Notes 中性🌱',
		app: { vault: { adapter: {}, configDir: '.obsidian' } },
		isAccountConfigured: () => true,
		getToken,
		getRemoteAccountId: async () => 'neutral-account',
		sync: {
			gc: { isRunningNow: () => false, runBlobGc },
			webdav: { createWebDAVClient: async () => ({}) },
		},
	} as unknown as NutstorePlugin
	const executor = new SyncExecutorService(plugin)
	Object.assign(plugin.sync, {
		lifecycle: new ModuleLifecycle(
			() => {},
			() => executor.stop(),
		),
	})
	return { plugin, executor, getToken, runBlobGc }
}

describe('synchronization execution gate', () => {
	it('refuses cold disabled requests before accessing credentials or showing notices', async () => {
		const f = fixture()
		expect(
			await f.executor.executeSync({ mode: SyncStartMode.MANUAL_SYNC }),
		).toBe(false)
		expect(f.getToken).not.toHaveBeenCalled()
		expect(construct).not.toHaveBeenCalled()
		expect(notice).not.toHaveBeenCalled()
	})

	it('cancels preparation even before a synchronization object subscribes to cancellation', async () => {
		const f = fixture()
		let token!: (value: string) => void
		f.getToken.mockImplementation(
			() =>
				new Promise((resolve) => {
					token = resolve
				}),
		)
		await f.plugin.sync.lifecycle.update(true)
		const work = f.executor.executeSync({ mode: SyncStartMode.AUTO_SYNC })
		await vi.waitFor(() => expect(f.getToken).toHaveBeenCalledOnce())
		await f.plugin.sync.lifecycle.update(false)
		token('test-only-late-token')
		expect(await work).toBe(false)
		expect(construct).not.toHaveBeenCalled()
		expect(f.runBlobGc).not.toHaveBeenCalled()
	})

	it('discards queued auto-sync and post-sync GC when a running sync is disabled', async () => {
		const f = fixture()
		let finish!: (result: { ended: boolean }) => void
		start.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		await f.plugin.sync.lifecycle.update(true)
		const running = f.executor.executeSync({ mode: SyncStartMode.AUTO_SYNC })
		await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
		await f.executor.executeSync({ mode: SyncStartMode.AUTO_SYNC })
		const stopping = f.plugin.sync.lifecycle.update(false)
		finish({ ended: true })
		await Promise.all([running, stopping])
		expect(start).toHaveBeenCalledTimes(1)
		expect(f.runBlobGc).not.toHaveBeenCalled()
		await f.plugin.sync.lifecycle.update(true)
		expect(
			await f.executor.executeSync({ mode: SyncStartMode.MANUAL_SYNC }),
		).toBe(true)
		expect(start).toHaveBeenCalledTimes(2)
	})
})
