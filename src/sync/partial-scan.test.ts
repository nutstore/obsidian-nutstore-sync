import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Vault } from 'obsidian'
import { Platform } from 'obsidian'
import type { WebDAVClient } from 'webdav'
import type NutstorePlugin from '~/index'
import type { StatModel } from '~/model/stat.model'
import { NutstoreFileSystem } from '~/fs/nutstore'
import { syncRecordKV } from '~/storage'
import { SyncRecord } from '~/storage/sync-record'
import { SyncPolicy } from '~/settings'
import {
	onEndSync,
	onPreparingSync,
	onSyncError,
	onSyncCancelled,
} from '~/events'
import { getDBKey } from '~/utils/get-db-key'
import { normalizeVaultPath } from '~/utils/normalize-vault-path'
import { NutstoreSync, SyncStartMode } from '.'

vi.mock('obsidian', () => ({
	normalizePath: (path: string) => normalizeVaultPath(path) || '/',
	TFile: class {},
	TFolder: class {},
	Modal: class {},
	Notice: class {},
	Platform: { isMobile: false, isDesktopApp: true, isMobileApp: false },
}))
vi.mock('~/settings', () => ({
	SyncMode: { STRICT: 'strict', LOOSE: 'loose' },
	SyncPolicy: {
		TwoWay: 'two-way',
		SendOnly: 'send-only',
		SendOnlyOverrideChanges: 'send-only-override-changes',
		ReceiveOnly: 'receive-only',
		ReceiveOnlyRevertLocalChanges: 'receive-only-revert-local-changes',
	},
}))
vi.mock('~/components/FailedTasksModal', () => ({
	default: class {
		open() {}
	},
}))
vi.mock('~/components/TaskListConfirmModal', () => ({ default: class {} }))
vi.mock('~/components/DeleteConfirmModal', () => ({ default: class {} }))

interface Entry {
	isDir: boolean
	mtime: number
	content: ArrayBuffer
}

/** Only host I/O and remote discovery are simulated; scan, decisions, task
 * optimization, execution, record persistence and completion events are real. */
class MemoryTree {
	readonly entries = new Map<string, Entry>()
	readonly writes: string[] = []

	put(path: string, text?: string, mtime = 1000): void {
		path = normalizeVaultPath(path)
		const parts = path.split('/')
		for (let i = 1; i < parts.length; i++) {
			const parent = parts.slice(0, i).join('/')
			if (!this.entries.has(parent)) this.put(parent)
		}
		this.entries.set(path, {
			isDir: text === undefined,
			mtime,
			content: new TextEncoder().encode(text ?? '').buffer,
		})
	}

	stat(path: string): StatModel | undefined {
		path = normalizeVaultPath(path)
		const entry = this.entries.get(path)
		return (
			entry && {
				path,
				basename: path.split('/').at(-1)!,
				isDir: entry.isDir,
				isDeleted: false,
				mtime: entry.mtime,
				size: entry.content.byteLength,
			}
		)
	}

	list(path: string) {
		const parent = normalizeVaultPath(path)
		const children = [...this.entries].filter(
			([child]) =>
				(child.includes('/') ? child.slice(0, child.lastIndexOf('/')) : '') ===
				parent,
		)
		return {
			files: children.filter(([, entry]) => !entry.isDir).map(([p]) => p),
			folders: children.filter(([, entry]) => entry.isDir).map(([p]) => p),
		}
	}

	write(path: string, content: ArrayBuffer): void {
		path = normalizeVaultPath(path)
		this.writes.push(path)
		this.entries.set(path, { isDir: false, mtime: 3000, content })
	}

	remove(path: string): void {
		path = normalizeVaultPath(path)
		this.writes.push(path)
		for (const key of this.entries.keys()) {
			if (key === path || key.startsWith(`${path}/`)) this.entries.delete(key)
		}
	}

	snapshot(root: string) {
		return [...this.entries]
			.filter(([p]) => p === root || p.startsWith(`${root}/`))
			.map(([path, entry]) => [
				path,
				{ ...entry, content: Array.from(new Uint8Array(entry.content)) },
			])
	}

	bytes(path: string) {
		return new Uint8Array(this.entries.get(path)!.content)
	}
}

const subscriptions: { unsubscribe(): void }[] = []
afterEach(() => {
	subscriptions.splice(0).forEach((subscription) => subscription.unsubscribe())
	vi.restoreAllMocks()
	Object.assign(Platform, {
		isMobile: false,
		isMobileApp: false,
		isDesktopApp: true,
	})
})

async function fixture(policy: SyncPolicy) {
	const local = new MemoryTree()
	const remote = new MemoryTree()
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
	for (const tree of [local, remote]) {
		tree.put(common, 'Original 原文🌱')
		tree.put(healthy, 'Original 原文🌱')
	}
	const baseline = new Map(
		[...local.entries.keys()].map((path) => [
			path,
			{ local: local.stat(path)!, remote: remote.stat(path)! },
		]),
	)
	baseline.set(orphan, {
		local: { ...local.stat(common)!, path: orphan },
		remote: { ...remote.stat(common)!, path: orphan },
	})
	local.put(localOnly, 'Local 本地🌿')
	remote.put(remoteOnly, 'Remote 远端📘')
	const source = receiving ? remote : local
	source.put(common, 'Updated 更新📘', 2000)
	source.put(healthy, 'Updated 更新📘', 2000)

	const list = vi.fn(async (path: string) => local.list(path))
	const stat = vi.fn(async (path: string) => {
		const entry = local.stat(path)
		return entry
			? {
					type: entry.isDir ? 'folder' : 'file',
					mtime: entry.mtime,
					ctime: entry.mtime,
					size: entry.isDir ? 0 : entry.size,
				}
			: null
	})
	const id = crypto.randomUUID()
	const vault = {
		configDir: '.obsidian',
		getName: () => `Scan 验收🌱 ${id}`,
		getRoot: () => ({ path: '/' }),
		getAbstractFileByPath: () => null,
		adapter: {
			list,
			stat,
			exists: async (path: string) =>
				local.entries.has(normalizeVaultPath(path)),
			readBinary: async (path: string) => local.entries.get(path)!.content,
			writeBinary: async (path: string, content: ArrayBuffer) =>
				local.write(path, content),
			mkdir: async (path: string) => {
				local.writes.push(path)
				local.put(path)
			},
			remove: async (path: string) => local.remove(path),
			rmdir: async (path: string) => local.remove(path),
		},
	} as unknown as Vault
	const storage = new SyncRecord(
		getDBKey(vault.getName(), '/remote/'),
		syncRecordKV,
	)
	await storage.setRecords(baseline)
	const relative = (path: string) => path.replace(/^\/remote\//, '')
	const webdav = {
		exists: vi.fn(async () => true),
		createDirectory: vi.fn(async (path: string) => {
			remote.writes.push(relative(path))
			remote.put(relative(path))
		}),
		putFileContents: vi.fn(async (path: string, content: ArrayBuffer) => {
			remote.write(relative(path), content)
			return true
		}),
		getFileContents: vi.fn(
			async (path: string) => remote.entries.get(relative(path))!.content,
		),
		customRequest: vi.fn(
			async (path: string, options: { headers: { Range: string } }) => {
				const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(
					options.headers.Range,
				)!
				const content = remote.entries.get(relative(path))!.content
				return new Response(content.slice(Number(start), Number(end) + 1), {
					status: 206,
				})
			},
		),
		deleteFile: vi.fn(async (path: string) => remote.remove(relative(path))),
	} as unknown as WebDAVClient
	const remoteWalk = vi
		.spyOn(NutstoreFileSystem.prototype, 'walk')
		.mockImplementation(async () =>
			[...remote.entries.keys()].map((path) => ({
				stat: remote.stat(path)!,
				ignored: false,
			})),
		)
	const plugin = {
		app: { vault, fileManager: {} },
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
		scanIssues?: readonly { path: string }[]
	}[] = []
	const errors: Error[] = []
	const cancelled = vi.fn()
	/** Run boundaries in order, to check every outcome closes a started run. */
	const lifecycle: string[] = []
	subscriptions.push(
		onPreparingSync().subscribe(() => lifecycle.push('preparing')),
		onEndSync().subscribe((event) => {
			lifecycle.push('end')
			ends.push(event)
		}),
		onSyncError().subscribe((error) => {
			lifecycle.push('error')
			errors.push(error)
		}),
		onSyncCancelled().subscribe(() => {
			lifecycle.push('cancelled')
			cancelled()
		}),
	)
	const run = async (mode = SyncStartMode.AUTO_SYNC, signal?: AbortSignal) => {
		const sync = new NutstoreSync(plugin, {
			vault,
			webdav,
			remoteBaseDir: '/remote/',
			token: '',
			remoteAccountId: 'neutral-test-account',
			signal,
		})
		return await sync.start({ mode, syncPolicy: policy })
	}
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
		storage,
		plugin,
		webdav,
		remoteWalk,
		ends,
		errors,
		cancelled,
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
				const readList = f.list.getMockImplementation()!
				const readStat = f.stat.getMockImplementation()!
				if (failure === 'list')
					f.list.mockImplementation(async (p) => {
						if (p === f.blocked)
							throw new Error('Section unavailable 小节暂不可用🌱')
						return readList(p)
					})
				else
					f.stat.mockImplementation(async (p) => {
						if (p !== f.blocked) return readStat(p)
						if (failure === 'missing') return null
						throw new Error('Metadata unavailable 元数据暂不可用📘')
					})
				const beforeLocal = f.local.snapshot(f.blocked)
				const beforeRemote = f.remote.snapshot(f.blocked)
				const beforeRecords = await f.storage.getRecords()
				expect(await f.run()).toMatchObject({
					completed: true,
					ranTasks: true,
				})
				expect(f.errors).toEqual([])
				expect(f.ends.at(-1)).toMatchObject({
					failedCount: 0,
					scanIssues: [{ path: f.blocked }],
				})
				expect(f.local.snapshot(f.blocked)).toEqual(beforeLocal)
				expect(f.remote.snapshot(f.blocked)).toEqual(beforeRemote)
				const afterRecords = await f.storage.getRecords()
				for (const [path, record] of beforeRecords) {
					if (path.startsWith(`${f.blocked}/`) || path === f.blocked)
						expect(afterRecords.get(path)).toEqual(record)
				}
				expect(f.local.bytes(f.healthy)).toEqual(f.remote.bytes(f.healthy))
				expect(afterRecords.get(f.healthy)?.local.mtime).toBe(
					f.local.stat(f.healthy)!.mtime,
				)
				const writes = [...f.local.writes, ...f.remote.writes]
				expect(writes).toContain(f.healthy)
				expect(
					writes.some((p) => p === f.blocked || p.startsWith(`${f.blocked}/`)),
				).toBe(false)

				f.list.mockImplementation(readList)
				f.stat.mockImplementation(readStat)
				expect(await f.run(SyncStartMode.MANUAL_SYNC)).toMatchObject({
					completed: true,
				})
				expect(f.errors).toEqual([])
				expect(f.ends.at(-1)).toMatchObject({ failedCount: 0, scanIssues: [] })
				expect(f.local.bytes(f.common)).toEqual(f.remote.bytes(f.common))
				expect((await f.storage.getRecords()).has(f.orphan)).toBe(false)
				const writeCount = f.local.writes.length + f.remote.writes.length
				expect(await f.run(SyncStartMode.MANUAL_SYNC)).toMatchObject({
					completed: true,
				})
				expect(f.local.writes.length + f.remote.writes.length).toBe(writeCount)
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
			const readList = f.list.getMockImplementation()!
			f.list.mockImplementation(async (p) => {
				if (p === f.blocked)
					throw new Error('Section unavailable 小节暂不可用🌱')
				return readList(p)
			})
			const beforeLocal = f.local.snapshot(f.blocked)
			const beforeRemote = f.remote.snapshot(f.blocked)
			expect(await f.run()).toMatchObject({ completed: true })
			expect(f.errors).toEqual([])
			expect(f.ends.at(-1)).toMatchObject({
				failedCount: 0,
				scanIssues: [{ path: f.blocked }],
			})
			expect(f.local.snapshot(f.blocked)).toEqual(beforeLocal)
			expect(f.remote.snapshot(f.blocked)).toEqual(beforeRemote)
			expect(f.local.bytes(f.healthy)).toEqual(f.remote.bytes(f.healthy))
			f.list.mockImplementation(readList)
			expect(await f.run()).toMatchObject({ completed: true })
			expect(f.errors).toEqual([])
			expect(f.ends.at(-1)).toMatchObject({ failedCount: 0, scanIssues: [] })
			expect(f.local.bytes(f.common)).toEqual(f.remote.bytes(f.common))
			if (f.receiving) expect(f.webdav.customRequest).toHaveBeenCalled()
		},
	)

	it.each(Object.values(SyncPolicy))(
		'does not let a directory-only exclusion suppress an ordinary file in %s',
		async (policy) => {
			const f = await fixture(policy)
			// Gitignore's trailing slash excludes directories, so a file with the
			// same name must still synchronize and retain its existing history.
			f.plugin.settings.filterRules.rules.push({
				expr: `/${f.healthy}/`,
				type: 'exclude',
				options: { caseSensitive: true },
			})
			expect(await f.run()).toMatchObject({ completed: true })
			expect(f.errors).toEqual([])
			expect(f.local.bytes(f.healthy)).toEqual(f.remote.bytes(f.healthy))
			expect([...f.local.writes, ...f.remote.writes]).toContain(f.healthy)
		},
	)

	it('keeps an ancestor containing an unreadable section when receive-only mirror deletes its healthy siblings', async () => {
		const f = await fixture(SyncPolicy.ReceiveOnlyRevertLocalChanges)
		const readList = f.list.getMockImplementation()!
		f.list.mockImplementation(async (p) => {
			if (p === f.blocked) throw new Error('Section unavailable 小节暂不可用🌱')
			return readList(p)
		})
		const protectedContents = f.local.snapshot(f.blocked)
		const beforeRecords = await f.storage.getRecords()
		f.remote.remove(f.parent)
		f.remote.writes.length = 0
		expect(await f.run()).toMatchObject({ completed: true })
		expect(f.errors).toEqual([])
		expect(f.ends.at(-1)).toMatchObject({ failedCount: 0 })
		expect(f.local.snapshot(f.blocked)).toEqual(protectedContents)
		expect(f.local.entries.has(f.parent)).toBe(true)
		expect(f.local.entries.has(f.healthy)).toBe(false)
		expect(f.local.writes).not.toContain(f.parent)
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
			f.local.entries.delete(f.healthy)
			f.remote.entries.delete(f.healthy)
			const readList = f.list.getMockImplementation()!
			f.list.mockImplementation(async (p) => {
				if (p === '.scan-case')
					throw new Error('Directory unavailable 目录暂不可用🌱')
				return readList(p)
			})
			const before = await f.storage.getRecords()
			expect(await f.run(mode)).toMatchObject({
				completed: true,
				ranTasks: false,
			})
			// Every normal outcome opens and closes one run, including a no-op.
			expect(f.lifecycle).toEqual(['preparing', 'end'])
			expect(f.ends).toMatchObject([
				{
					failedCount: 0,
					showNotice,
					scanIssues: [{ path: '.scan-case' }],
				},
			])
			expect(await f.storage.getRecords()).toEqual(before)
			expect([...f.local.writes, ...f.remote.writes]).toEqual([])
		},
	)

	it('reports only unreadable paths that are still inside the sync scope', async () => {
		const f = await fixture(SyncPolicy.TwoWay)
		const excluded = `${f.parent}/Excluded 已排除🌿`
		f.local.entries.set(excluded, {
			isDir: true,
			mtime: 1000,
			content: new ArrayBuffer(0),
		})
		f.plugin.settings.filterRules.rules.push({
			expr: `/${excluded}/`,
			type: 'exclude',
			options: { caseSensitive: true },
		})
		const readList = f.list.getMockImplementation()!
		f.list.mockImplementation(async (p) => {
			if (p === excluded) throw new Error('Excluded unavailable 暂不可用🌱')
			if (p === f.blocked) throw new Error('Included unavailable 暂不可用🌿')
			return readList(p)
		})
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
		const readList = f.list.getMockImplementation()!
		f.list.mockImplementation(async (p) => {
			if (p === f.blocked)
				throw new Error('Excluded section unavailable 已排除小节暂不可用🌱')
			return readList(p)
		})
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
			f.list.mockRejectedValue(new Error('Root unavailable 根目录暂不可用🌱'))
			vi.mocked(f.webdav.exists).mockResolvedValue(false)
			expect(await f.run(mode)).toMatchObject({ completed: false })
			expect(f.errors).toMatchObject([{ name: 'LocalScanError' }])
			expect(f.webdav.exists).toHaveBeenCalledOnce()
			expect(f.remoteWalk).not.toHaveBeenCalled()
			expect(await f.storage.getRecords()).toEqual(before)
			expect([...f.local.writes, ...f.remote.writes]).toEqual([])
		},
	)

	it('preserves cancellation during a nested listing instead of continuing with partial sync', async () => {
		const f = await fixture(SyncPolicy.TwoWay)
		const readList = f.list.getMockImplementation()!
		f.list.mockImplementation(async (p) => {
			if (p === f.blocked)
				throw new DOMException('Cancelled 已取消🌱', 'AbortError')
			return readList(p)
		})
		expect(await f.run()).toMatchObject({ completed: false })
		expect(f.cancelled).toHaveBeenCalledOnce()
		expect(f.errors).toEqual([])
		expect(f.webdav.exists).toHaveBeenCalledOnce()
		expect([...f.local.writes, ...f.remote.writes]).toEqual([])
	})

	it.each([SyncStartMode.AUTO_SYNC, SyncStartMode.MANUAL_SYNC])(
		'stops %s at a rate-limited root probe before reading local files',
		async (mode) => {
			const f = await fixture(SyncPolicy.TwoWay)
			const before = await f.storage.getRecords()
			vi.mocked(f.webdav.exists).mockRejectedValueOnce(
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
			expect([...f.local.writes, ...f.remote.writes]).toEqual([])
		},
	)

	it('retains protected records when initializing a missing remote root', async () => {
		const f = await fixture(SyncPolicy.SendOnlyOverrideChanges)
		const readList = f.list.getMockImplementation()!
		f.list.mockImplementation(async (p) => {
			if (p === f.blocked) throw new Error('Section unavailable 小节暂不可用🌱')
			return readList(p)
		})
		const before = await f.storage.getRecords()
		f.remote.entries.clear()
		vi.mocked(f.webdav.exists).mockResolvedValue(false)
		expect(await f.run()).toMatchObject({ completed: true })
		expect(f.errors).toEqual([])
		const after = await f.storage.getRecords()
		expect(after.get(f.common)).toEqual(before.get(f.common))
		expect(after.get(f.orphan)).toEqual(before.get(f.orphan))
		expect(f.remote.bytes(f.healthy)).toEqual(f.local.bytes(f.healthy))
	})
})
