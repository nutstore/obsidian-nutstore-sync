import { afterEach, describe, expect, it, vi } from 'vitest'
import { Platform } from 'obsidian'
import { createMemoryClock, MemoryVault } from '@test/harness/memory-vault'
import { MemoryWebDAV } from '@test/harness/memory-webdav'
import {
	onEndSync,
	onPreparingSync,
	onSyncCancelled,
	onSyncError,
} from '~/events'
import { NutstoreFileSystem } from '~/fs/nutstore'
import type NutstorePlugin from '~/index'
import type { StatModel } from '~/model/stat.model'
import { SyncPolicy } from '~/settings'
import { syncRecordKV } from '~/storage'
import { SyncRecord } from '~/storage/sync-record'
import { getDBKey } from '~/utils/get-db-key'
import { NutstoreSync, SyncStartMode } from '.'

vi.mock('~/components/FailedTasksModal', () => ({
	default: class {
		open() {}
	},
}))
vi.mock('~/components/TaskListConfirmModal', () => ({ default: class {} }))
vi.mock('~/components/DeleteConfirmModal', () => ({ default: class {} }))

const REMOTE_BASE = '/remote'

const subscriptions: { unsubscribe(): void }[] = []
afterEach(() => {
	subscriptions.splice(0).forEach((s) => s.unsubscribe())
	vi.restoreAllMocks()
	Object.assign(Platform, {
		isMobile: false,
		isMobileApp: false,
		isDesktopApp: true,
	})
})

function subtreeSnapshot(
	nodes: Map<
		string,
		{ kind: string; mtime?: number; mtimeMs?: number; bytes?: Uint8Array }
	>,
	prefixRoot: string,
) {
	return [...nodes.entries()]
		.filter(([p]) => p === prefixRoot || p.startsWith(`${prefixRoot}/`))
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([p, n]) => [
			p,
			n.kind,
			n.mtime ?? n.mtimeMs,
			n.bytes ? Array.from(n.bytes) : null,
		])
}

async function fixture(policy: SyncPolicy) {
	const clock = createMemoryClock(3000)
	const local = new MemoryVault({
		name: `Scan 验收🌱 ${crypto.randomUUID()}`,
		clock,
	})
	const remote = new MemoryWebDAV({ clock })
	remote.seedDir(REMOTE_BASE, 1000)

	const parent = '.scan-case/Notes 笔记🌱'
	const blocked = `${parent}/Section 小节📘`
	const healthy = `${parent}/Example 示例🌿.bin`
	const common = `${blocked}/Shared 共有🌱.bin`
	const localOnly = `${blocked}/Local 本地🌿.bin`
	const remoteOnly = `${blocked}/Remote 远端📘.bin`
	const orphan = `${blocked}/Removed 已移除🌱.bin`
	const receiving = [
		SyncPolicy.ReceiveOnly,
		SyncPolicy.ReceiveOnlyRevertLocalChanges,
	].includes(policy)

	for (const p of [common, healthy]) {
		local.seedFile(p, 'Original 原文🌱', 1000)
		remote.seedFile(`${REMOTE_BASE}/${p}`, 'Original 原文🌱', 1000)
	}
	const toStat = (
		path: string,
		node: {
			kind: string
			mtime?: number
			mtimeMs?: number
			bytes?: Uint8Array
			etag?: string
		},
	): StatModel =>
		node.kind === 'file'
			? {
					path,
					basename: path.split('/').at(-1)!,
					isDir: false,
					isDeleted: false,
					mtime: node.mtime ?? node.mtimeMs ?? 1000,
					size: node.bytes?.byteLength ?? 0,
					etag: node.etag ?? null,
				}
			: {
					path,
					basename: path.split('/').at(-1)!,
					isDir: true,
					isDeleted: false,
					mtime: node.mtime ?? node.mtimeMs ?? 1000,
				}
	const baseline = new Map(
		[...local.nodes.entries()].map(([path, node]) => [
			path,
			{
				local: toStat(path, node),
				remote: toStat(path, remote.nodes.get(`${REMOTE_BASE}/${path}`)!),
			},
		]),
	)
	const commonStat = toStat(common, local.nodes.get(common)!)
	baseline.set(orphan, {
		local: { ...commonStat, path: orphan },
		remote: { ...commonStat, path: orphan },
	})

	local.seedFile(localOnly, 'Local 本地🌿', 1000)
	remote.seedFile(`${REMOTE_BASE}/${remoteOnly}`, 'Remote 远端📘', 1000)
	if (receiving) {
		remote.seedFile(`${REMOTE_BASE}/${common}`, 'Updated 更新📘', 2000)
		remote.seedFile(`${REMOTE_BASE}/${healthy}`, 'Updated 更新📘', 2000)
	} else {
		local.seedFile(common, 'Updated 更新📘', 2000)
		local.seedFile(healthy, 'Updated 更新📘', 2000)
	}

	const storage = new SyncRecord(
		getDBKey(local.vault.getName(), `${REMOTE_BASE}/`),
		syncRecordKV,
	)
	await storage.setRecords(baseline)

	const rawStat = local.adapter.stat.bind(local.adapter)
	const list = vi.spyOn(local.adapter, 'list')
	const stat = vi.spyOn(local.adapter, 'stat')
	const existsSpy = vi.spyOn(remote.client, 'exists')
	const rangeSpy = vi.spyOn(remote.client, 'customRequest')
	const remoteWalk = vi
		.spyOn(NutstoreFileSystem.prototype, 'walk')
		.mockImplementation(async () =>
			[...remote.nodes.entries()]
				.filter(([p]) => p.startsWith(`${REMOTE_BASE}/`))
				.map(([p, node]) => ({
					stat: toStat(p.slice(REMOTE_BASE.length + 1), node),
					ignored: false,
				})),
		)

	const plugin = {
		app: local.app,
		manifest: { id: 'nutstore-sync' },
		settings: {
			filterRules: { rules: [] },
			configDirSyncMode: 'none',
			skipLargeFiles: { maxSize: '' },
			syncMode: 'strict',
			conflictStrategy: 'local-priority',
			confirmBeforeSync: false,
			confirmBeforeDeleteInAutoSync: false,
		},
		localSettings: { syncPolicy: policy },
		getToken: async () => 'neutral-test-token',
		getRemoteAccountId: async () => 'neutral-test-account',
	} as unknown as NutstorePlugin

	const ends: {
		failedCount: number
		showNotice?: boolean
		scanIssues?: readonly { path: string }[]
	}[] = []
	const errors: Error[] = []
	const cancelled = vi.fn()
	const lifecycle: string[] = []
	subscriptions.push(
		onPreparingSync().subscribe(() => lifecycle.push('preparing')),
		onEndSync().subscribe((e) => {
			lifecycle.push('end')
			ends.push(e)
		}),
		onSyncError().subscribe((e) => {
			lifecycle.push('error')
			errors.push(e)
		}),
		onSyncCancelled().subscribe(() => {
			lifecycle.push('cancelled')
			cancelled()
		}),
	)

	const allWrites = () => [
		...local.mutations.map((m) => m.path),
		...remote.mutatingOps.map((m) => m.path.replace(/^\/remote\//, '')),
	]

	const run = async (mode = SyncStartMode.AUTO_SYNC, signal?: AbortSignal) =>
		new NutstoreSync(plugin, {
			vault: local.vault,
			webdav: remote.client,
			remoteBaseDir: `${REMOTE_BASE}/`,
			token: '',
			remoteAccountId: 'neutral-test-account',
			signal,
		}).start({ mode, syncPolicy: policy })

	return {
		lifecycle,
		local,
		remote,
		parent,
		blocked,
		healthy,
		common,
		orphan,
		list,
		stat,
		rawStat,
		existsSpy,
		rangeSpy,
		storage,
		plugin,
		remoteWalk,
		ends,
		errors,
		cancelled,
		allWrites,
		run,
		receiving,
	}
}

describe.each(Object.values(SyncPolicy))(
	'partial scan through the sync entry point: %s',
	(policy) => {
		it.each(['list', 'stat', 'missing'] as const)(
			'preserves both sides and history on %s failure, syncs siblings, and recovers next run',
			async (failure) => {
				const f = await fixture(policy)
				if (failure === 'list') {
					f.local.faults.onList = (p) =>
						p === f.blocked
							? new Error('Section unavailable 小节暂不可用🌱')
							: undefined
				} else if (failure === 'stat') {
					f.local.faults.onStat = (p) =>
						p === f.blocked
							? new Error('Metadata unavailable 元数据暂不可用📘')
							: undefined
				} else {
					f.stat.mockImplementation(async (p) =>
						p === f.blocked ? null : f.rawStat(p),
					)
				}

				const beforeLocal = subtreeSnapshot(f.local.nodes, f.blocked)
				const beforeRemote = subtreeSnapshot(
					f.remote.nodes,
					`${REMOTE_BASE}/${f.blocked}`,
				)
				const beforeRecords = await f.storage.getRecords()
				expect(await f.run()).toMatchObject({ completed: true, ranTasks: true })
				expect(f.errors).toEqual([])
				expect(f.ends.at(-1)).toMatchObject({
					failedCount: 0,
					scanIssues: [{ path: f.blocked }],
				})
				expect(subtreeSnapshot(f.local.nodes, f.blocked)).toEqual(beforeLocal)
				expect(
					subtreeSnapshot(f.remote.nodes, `${REMOTE_BASE}/${f.blocked}`),
				).toEqual(beforeRemote)
				const afterRecords = await f.storage.getRecords()
				for (const [path, record] of beforeRecords) {
					if (path.startsWith(`${f.blocked}/`) || path === f.blocked) {
						expect(afterRecords.get(path)).toEqual(record)
					}
				}
				expect(f.local.readBytesDirect(f.healthy)).toEqual(
					f.remote.readBytesDirect(`${REMOTE_BASE}/${f.healthy}`),
				)
				expect(afterRecords.get(f.healthy)?.local.mtime).toBe(
					f.local.nodes.get(f.healthy)?.mtime,
				)
				const writes = f.allWrites()
				expect(writes).toContain(f.healthy)
				expect(
					writes.some((p) => p === f.blocked || p.startsWith(`${f.blocked}/`)),
				).toBe(false)

				f.local.faults.onList = undefined
				f.local.faults.onStat = undefined
				f.stat.mockRestore()
				expect(await f.run(SyncStartMode.MANUAL_SYNC)).toMatchObject({
					completed: true,
				})
				expect(f.errors).toEqual([])
				expect(f.ends.at(-1)).toMatchObject({ failedCount: 0, scanIssues: [] })
				expect(f.local.readBytesDirect(f.common)).toEqual(
					f.remote.readBytesDirect(`${REMOTE_BASE}/${f.common}`),
				)
				expect((await f.storage.getRecords()).has(f.orphan)).toBe(false)
				const writeCount = f.allWrites().length
				expect(await f.run(SyncStartMode.MANUAL_SYNC)).toMatchObject({
					completed: true,
				})
				expect(f.allWrites().length).toBe(writeCount)
			},
		)
	},
)

describe('partial scan safety boundaries', () => {
	it.each(Object.values(SyncPolicy))(
		'preserves partial scanning and recovery with mobile range downloads in %s',
		async (policy) => {
			Object.assign(Platform, {
				isMobile: true,
				isMobileApp: true,
				isDesktopApp: false,
			})
			const f = await fixture(policy)
			f.local.faults.onList = (p) =>
				p === f.blocked
					? new Error('Section unavailable 小节暂不可用🌱')
					: undefined
			const beforeLocal = subtreeSnapshot(f.local.nodes, f.blocked)
			const beforeRemote = subtreeSnapshot(
				f.remote.nodes,
				`${REMOTE_BASE}/${f.blocked}`,
			)
			expect(await f.run()).toMatchObject({ completed: true })
			expect(f.errors).toEqual([])
			expect(f.ends.at(-1)).toMatchObject({
				failedCount: 0,
				scanIssues: [{ path: f.blocked }],
			})
			expect(subtreeSnapshot(f.local.nodes, f.blocked)).toEqual(beforeLocal)
			expect(
				subtreeSnapshot(f.remote.nodes, `${REMOTE_BASE}/${f.blocked}`),
			).toEqual(beforeRemote)
			expect(f.local.readBytesDirect(f.healthy)).toEqual(
				f.remote.readBytesDirect(`${REMOTE_BASE}/${f.healthy}`),
			)

			f.local.faults.onList = undefined
			expect(await f.run()).toMatchObject({ completed: true })
			expect(f.errors).toEqual([])
			expect(f.ends.at(-1)).toMatchObject({ failedCount: 0, scanIssues: [] })
			expect(f.local.readBytesDirect(f.common)).toEqual(
				f.remote.readBytesDirect(`${REMOTE_BASE}/${f.common}`),
			)
			if (f.receiving) expect(f.rangeSpy).toHaveBeenCalled()
		},
	)

	it.each(Object.values(SyncPolicy))(
		'does not let a directory-only exclusion suppress an ordinary file in %s',
		async (policy) => {
			const f = await fixture(policy)
			f.plugin.settings.filterRules.rules.push({
				expr: `/${f.healthy}/`,
				type: 'exclude',
				options: { caseSensitive: true },
			})
			expect(await f.run()).toMatchObject({ completed: true })
			expect(f.errors).toEqual([])
			expect(f.local.readBytesDirect(f.healthy)).toEqual(
				f.remote.readBytesDirect(`${REMOTE_BASE}/${f.healthy}`),
			)
			expect(f.allWrites()).toContain(f.healthy)
		},
	)

	it('keeps an ancestor containing an unreadable section when receive-only mirror deletes its healthy siblings', async () => {
		const f = await fixture(SyncPolicy.ReceiveOnlyRevertLocalChanges)
		f.local.faults.onList = (p) =>
			p === f.blocked
				? new Error('Section unavailable 小节暂不可用🌱')
				: undefined
		const protectedContents = subtreeSnapshot(f.local.nodes, f.blocked)
		const beforeRecords = await f.storage.getRecords()
		f.remote.deleteDirect(`${REMOTE_BASE}/${f.parent}`)
		f.remote.clearOps()
		expect(await f.run()).toMatchObject({ completed: true })
		expect(f.errors).toEqual([])
		expect(f.ends.at(-1)).toMatchObject({ failedCount: 0 })
		expect(subtreeSnapshot(f.local.nodes, f.blocked)).toEqual(protectedContents)
		expect(f.local.nodes.has(f.parent)).toBe(true)
		expect(f.local.nodes.has(f.healthy)).toBe(false)
		expect(f.local.mutations.map((m) => m.path)).not.toContain(f.parent)
		expect((await f.storage.getRecords()).get(f.common)).toEqual(
			beforeRecords.get(f.common),
		)
	})

	it.each([
		[SyncStartMode.AUTO_SYNC, false],
		[SyncStartMode.MANUAL_SYNC, true],
	] as const)(
		'reports partial completion even when every candidate is protected in %s',
		async (mode, showNotice) => {
			const f = await fixture(SyncPolicy.TwoWay)
			f.local.removeDirect(f.healthy)
			f.remote.deleteDirect(`${REMOTE_BASE}/${f.healthy}`)
			f.local.faults.onList = (p) =>
				p === '.scan-case'
					? new Error('Directory unavailable 目录暂不可用🌱')
					: undefined
			const before = await f.storage.getRecords()
			expect(await f.run(mode)).toMatchObject({
				completed: true,
				ranTasks: false,
			})
			expect(f.lifecycle).toEqual(['preparing', 'end'])
			expect(f.ends).toMatchObject([
				{ failedCount: 0, showNotice, scanIssues: [{ path: '.scan-case' }] },
			])
			expect(await f.storage.getRecords()).toEqual(before)
			expect(f.allWrites()).toEqual([])
		},
	)

	it('reports only unreadable paths that are still inside the sync scope', async () => {
		const f = await fixture(SyncPolicy.TwoWay)
		const excluded = `${f.parent}/Excluded 已排除🌿`
		f.local.seedFolder(excluded, 1000)
		f.plugin.settings.filterRules.rules.push({
			expr: `/${excluded}/`,
			type: 'exclude',
			options: { caseSensitive: true },
		})
		f.local.faults.onList = (p) => {
			if (p === excluded) return new Error('Excluded unavailable 暂不可用🌱')
			if (p === f.blocked) return new Error('Included unavailable 暂不可用🌿')
		}
		await f.run()
		expect(f.list).not.toHaveBeenCalledWith(excluded)
		expect(f.ends.at(-1)?.scanIssues?.map((issue) => issue.path)).toEqual([
			f.blocked,
		])
	})

	it('never reads an excluded inaccessible section or discards its history', async () => {
		const f = await fixture(SyncPolicy.SendOnlyOverrideChanges)
		f.plugin.settings.filterRules.rules.push({
			expr: `/${f.blocked}/`,
			type: 'exclude',
			options: { caseSensitive: true },
		})
		f.local.faults.onList = (p) =>
			p === f.blocked
				? new Error('Excluded section unavailable 已排除小节暂不可用🌱')
				: undefined
		const before = await f.storage.getRecords()
		expect(await f.run()).toMatchObject({ completed: true })
		expect(f.ends.at(-1)).toMatchObject({ failedCount: 0, scanIssues: [] })
		expect(f.list).not.toHaveBeenCalledWith(f.blocked)
		expect((await f.storage.getRecords()).get(f.orphan)).toEqual(
			before.get(f.orphan),
		)
	})

	it.each([SyncStartMode.AUTO_SYNC, SyncStartMode.MANUAL_SYNC])(
		'stops %s after the remote probe but before remote traversal or history reset when the root cannot be listed',
		async (mode) => {
			const f = await fixture(SyncPolicy.TwoWay)
			const before = await f.storage.getRecords()
			f.local.faults.onList = () =>
				new Error('Root unavailable 根目录暂不可用🌱')
			f.existsSpy.mockResolvedValue(false)
			expect(await f.run(mode)).toMatchObject({ completed: false })
			expect(f.errors).toMatchObject([{ name: 'LocalScanError' }])
			expect(f.existsSpy).toHaveBeenCalledOnce()
			expect(f.remoteWalk).not.toHaveBeenCalled()
			expect(await f.storage.getRecords()).toEqual(before)
			expect(f.allWrites()).toEqual([])
		},
	)

	it('preserves cancellation during a nested listing instead of continuing with partial sync', async () => {
		const f = await fixture(SyncPolicy.TwoWay)
		f.local.faults.onList = (p) =>
			p === f.blocked
				? new DOMException('Cancelled 已取消🌱', 'AbortError')
				: undefined
		expect(await f.run()).toMatchObject({ completed: false })
		expect(f.cancelled).toHaveBeenCalledOnce()
		expect(f.errors).toEqual([])
		expect(f.existsSpy).toHaveBeenCalledOnce()
		expect(f.allWrites()).toEqual([])
	})

	it.each([SyncStartMode.AUTO_SYNC, SyncStartMode.MANUAL_SYNC])(
		'stops %s at a rate-limited root probe before reading local files',
		async (mode) => {
			const f = await fixture(SyncPolicy.TwoWay)
			const before = await f.storage.getRecords()
			f.existsSpy.mockRejectedValueOnce(
				new Error('Invalid response: 503 Service Unavailable'),
			)
			const startedAt = Date.now()
			const result = await f.run(mode)
			expect(result).toMatchObject({ completed: false, ranTasks: false })
			expect(result.rateLimitedUntil).toBeGreaterThanOrEqual(startedAt + 60_000)
			expect(f.list).not.toHaveBeenCalled()
			expect(f.remoteWalk).not.toHaveBeenCalled()
			expect(f.errors).toMatchObject([
				{ message: 'Invalid response: 503 Service Unavailable' },
			])
			expect(await f.storage.getRecords()).toEqual(before)
			expect(f.allWrites()).toEqual([])
		},
	)

	it('retains protected records when initializing a missing remote root', async () => {
		const f = await fixture(SyncPolicy.SendOnlyOverrideChanges)
		f.local.faults.onList = (p) =>
			p === f.blocked
				? new Error('Section unavailable 小节暂不可用🌱')
				: undefined
		const before = await f.storage.getRecords()
		f.remote.deleteDirect(REMOTE_BASE)
		f.remote.clearOps()
		expect(await f.run()).toMatchObject({ completed: true })
		expect(f.errors).toEqual([])
		const after = await f.storage.getRecords()
		expect(after.get(f.common)).toEqual(before.get(f.common))
		expect(after.get(f.orphan)).toEqual(before.get(f.orphan))
		expect(f.remote.readBytesDirect(`${REMOTE_BASE}/${f.healthy}`)).toEqual(
			f.local.readBytesDirect(f.healthy),
		)
	})
})
