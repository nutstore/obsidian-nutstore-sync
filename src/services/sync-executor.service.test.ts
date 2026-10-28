import { beforeEach, describe, expect, it, vi } from 'vitest'
import type NutstorePlugin from '~/index'
import type { SyncSelection } from '~/settings'
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
vi.mock('~/utils/logger', () => ({
	default: { info: vi.fn(), error: vi.fn() },
}))

beforeEach(() => {
	vi.clearAllMocks()
	start.mockResolvedValue({ ended: true, shouldReloadSettings: false })
})

function fixture(configDir = '.settings-设置-🌿') {
	const runBlobGc = vi.fn(async () => ({ ok: true, deletedCount: 0 }))
	const getToken = vi.fn(async () => 'test-only-token')
	const plugin = {
		isSyncing: false,
		settings: {
			filterRules: { rules: [] },
			conflictStrategy: 'no-conflict-merge',
		},
		localSettings: { syncPolicy: 'two-way' },
		remoteBaseDir: 'Notes 中性🌱',
		app: {
			workspace: { layoutReady: true },
			vault: { adapter: {}, configDir },
		},
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
	it('uses a manual selection without changing defaults or leaking into the next sync', async () => {
		const f = fixture()
		await f.plugin.sync.lifecycle.update(true)
		const selection = {
			syncPolicy: 'two-way',
			conflictStrategy: 'server-priority',
		} as SyncSelection
		const defaults = structuredClone(f.plugin.settings)
		expect(
			await f.executor.executeSync({
				mode: SyncStartMode.MANUAL_SYNC,
				...selection,
			}),
		).toBe(true)
		expect(construct).toHaveBeenLastCalledWith(
			f.plugin,
			expect.objectContaining({
				conflictStrategy: selection.conflictStrategy,
				remoteBaseDir: 'Notes 中性🌱',
			}),
		)
		expect(start).toHaveBeenLastCalledWith({
			mode: SyncStartMode.MANUAL_SYNC,
			syncPolicy: selection.syncPolicy,
		})
		expect(f.plugin.settings).toEqual(defaults)
		await f.executor.executeSync({ mode: SyncStartMode.AUTO_SYNC })
		expect(construct).toHaveBeenLastCalledWith(
			f.plugin,
			expect.objectContaining({ conflictStrategy: defaults.conflictStrategy }),
		)
	})

	it.each([SyncStartMode.AUTO_SYNC, SyncStartMode.MANUAL_SYNC])(
		'rejects %s before host readiness and allows a later request',
		async (mode) => {
			const f = fixture()
			f.plugin.app.workspace.layoutReady = false
			await f.plugin.sync.lifecycle.update(true)
			expect(await f.executor.executeSync({ mode })).toBe(false)
			expect(f.getToken).not.toHaveBeenCalled()
			expect(construct).not.toHaveBeenCalled()
			f.plugin.app.workspace.layoutReady = true
			expect(await f.executor.executeSync({ mode })).toBe(true)
			expect(start).toHaveBeenCalledOnce()
		},
	)

	it.each(['.settings-设置-🌿', '.preferences-偏好-🌱'])(
		'uses the actual vault directory for pruning notices and synchronization (%s)',
		async (configDir) => {
			const f = fixture(configDir)
			f.plugin.settings.configDirSyncMode = 'all'
			f.plugin.settings.filterRules.rules = [
				{ expr: configDir, options: { caseSensitive: true }, type: 'exclude' },
			]
			await f.plugin.sync.lifecycle.update(true)
			expect(
				await f.executor.executeSync({ mode: SyncStartMode.MANUAL_SYNC }),
			).toBe(true)
			expect(notice).toHaveBeenCalledOnce()
			expect(notice).toHaveBeenCalledWith(expect.stringContaining(configDir))
			expect(construct).toHaveBeenLastCalledWith(
				f.plugin,
				expect.objectContaining({
					vault: expect.objectContaining({ configDir }),
				}),
			)

			// A later include cancels pruning; the earlier exclusion alone
			// must not keep producing a warning on subsequent syncs.
			f.plugin.settings.filterRules.rules.push({
				expr: configDir,
				options: { caseSensitive: true },
				type: 'include',
			})
			notice.mockClear()
			expect(
				await f.executor.executeSync({ mode: SyncStartMode.MANUAL_SYNC }),
			).toBe(true)
			expect(notice).not.toHaveBeenCalled()
		},
	)

	it('reads the current directory again after the host configuration changes', async () => {
		const f = fixture('.settings-旧-🌿')
		f.plugin.settings.configDirSyncMode = 'all'
		f.plugin.settings.filterRules.rules = [
			{
				expr: '.settings-旧-🌿',
				options: { caseSensitive: true },
				type: 'exclude',
			},
		]
		await f.plugin.sync.lifecycle.update(true)
		await f.executor.executeSync({ mode: SyncStartMode.MANUAL_SYNC })
		expect(notice).toHaveBeenCalledOnce()
		f.plugin.app.vault.configDir = '.settings-新-🌱'
		notice.mockClear()
		await f.executor.executeSync({ mode: SyncStartMode.MANUAL_SYNC })
		expect(notice).not.toHaveBeenCalled()
		expect(construct).toHaveBeenLastCalledWith(
			f.plugin,
			expect.objectContaining({
				vault: expect.objectContaining({ configDir: '.settings-新-🌱' }),
			}),
		)
	})

	it('does not immediately restart an unsuccessful round from a queued request', async () => {
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
		finish({ ended: false })
		expect(await running).toBe(false)
		expect(f.executor.isRunning()).toBe(false)
		expect(f.runBlobGc).not.toHaveBeenCalled()
		expect(start).toHaveBeenCalledOnce()
		expect(
			await f.executor.executeSync({ mode: SyncStartMode.AUTO_SYNC }),
		).toBe(true)
		expect(start).toHaveBeenCalledTimes(2)
	})

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
