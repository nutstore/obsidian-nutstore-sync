import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileStat } from 'webdav'
import type { RequestUrlResponse } from 'obsidian'
import type { DeltaEntry } from '~/api/delta'
import { getDelta } from '~/api/delta'
import { getLatestDeltaCursor } from '~/api/latestDeltaCursor'
import { getDirectoryContents, statRemotePath } from '~/api/webdav'
import type { NutstoreSettings } from '~/settings'
import type { StatModel } from '~/model/stat.model'
import { traverseWebDAVKV, type TraverseWebDAVCache } from '~/storage'
import { fileStatToStatModel } from './file-stat-to-stat-model'
import { TRAVERSAL_CACHE_SCHEMA } from './get-db-key'
import { RequestUrlError } from './request-url-error'
import {
	FULL_RESCAN_INTERVAL_MS,
	ResumableWebDAVTraversal,
} from './traverse-webdav'

vi.mock('~/api/delta', () => ({ getDelta: vi.fn() }))
vi.mock('~/api/latestDeltaCursor', () => ({ getLatestDeltaCursor: vi.fn() }))
vi.mock('~/api/webdav', () => ({
	getDirectoryContents: vi.fn(),
	statRemotePath: vi.fn(),
}))
vi.mock('~/storage', () => ({
	traverseWebDAVKV: { get: vi.fn(), set: vi.fn(), unset: vi.fn() },
}))
vi.mock('./logger', () => ({
	default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))
vi.mock('./sleep', () => ({ default: vi.fn(async () => {}) }))

const root = '/Workspace/'
const folder = `${root}资料 Notes 📚 & 100%/`
const sibling = `${root}Archive 归档 🗂️/`
const note = `${folder}Example 示例 ✨.md`
const specialNote = `${folder}进度 100% #1 📘.md`
const canonical = (path: string) => path.replace(/\/$/, '')

function stat(
	path: string,
	dir = true,
	etag: string | null = 'etag-1',
): FileStat {
	return {
		filename: canonical(path),
		basename: canonical(path).split('/').pop()!,
		type: dir ? 'directory' : 'file',
		size: dir ? 0 : 12,
		lastmod: '2026-01-01T00:00:00Z',
		etag: dir ? null : etag,
	}
}

function entry(
	path: string,
	isDeleted: boolean,
	options: {
		isDir?: boolean
		revision?: number
		size?: number
		modified?: string
	} = {},
): DeltaEntry {
	return {
		path: canonical(path),
		isDeleted,
		isDir: options.isDir ?? true,
		size: options.size ?? 0,
		modified: options.modified ?? '2026-01-01T00:00:00Z',
		revision: options.revision ?? 1,
	}
}

function httpError(status = 404) {
	return new RequestUrlError({
		status,
		text: 'Resource unavailable',
	} as RequestUrlResponse)
}

function traversal(options?: {
	now?: () => number
	fullRescanIntervalMs?: number
}) {
	return new ResumableWebDAVTraversal({
		settings: {} as NutstoreSettings,
		token: 'test-token',
		remoteBaseDir: root,
		kvKey: 'test-cache',
		now: options?.now,
		fullRescanIntervalMs: options?.fullRescanIntervalMs,
	})
}

let cache: TraverseWebDAVCache | undefined

function delta(entries: DeltaEntry[], cursor = 'next') {
	vi.mocked(getDelta).mockReset()
	vi.mocked(getDelta)
		.mockResolvedValueOnce({
			response: {
				cursor,
				reset: false,
				hasMore: false,
				delta: { entry: entries },
			},
		})
		.mockResolvedValue({
			response: {
				cursor,
				reset: false,
				hasMore: false,
				delta: { entry: [] },
			},
		})
}

beforeEach(() => {
	vi.resetAllMocks()
	cache = undefined
	vi.mocked(traverseWebDAVKV.get).mockImplementation(
		async () => structuredClone(cache) ?? null,
	)
	vi.mocked(traverseWebDAVKV.set).mockImplementation(async (_key, value) => {
		cache = structuredClone(value)
		return value
	})
	vi.mocked(traverseWebDAVKV.unset).mockImplementation(async () => {
		cache = undefined
	})
	vi.mocked(getLatestDeltaCursor).mockResolvedValue({
		response: { cursor: 'start' },
	})
	vi.mocked(statRemotePath).mockResolvedValue({ status: 'not-found' })
	vi.mocked(getDelta).mockResolvedValue({
		response: {
			cursor: 'start',
			reset: false,
			hasMore: false,
			delta: { entry: [] },
		},
	})
})

describe('remote traversal recovery', () => {
	it('finishes siblings and lets delta delete a missing directory without rescanning', async () => {
		vi.mocked(getLatestDeltaCursor).mockResolvedValueOnce({
			response: { cursor: 'start' },
		})
		delta([entry(folder, true)])
		vi.mocked(getDirectoryContents).mockImplementation(async (_s, _t, path) => {
			if (canonical(path) === canonical(root))
				return [stat(folder), stat(sibling)]
			if (canonical(path) === canonical(folder)) throw httpError()
			return [stat(`${sibling}Summary 摘要 📝.md`, false)]
		})
		const result = await traversal().traverse()
		expect(result.map((item) => item.path)).toEqual([
			canonical(sibling),
			`${sibling}Summary 摘要 📝.md`,
		])
		expect(getDirectoryContents).toHaveBeenCalledTimes(3)
		expect(cache?.pendingVerification).toEqual([])
	})

	it('refreshes one parent for multiple missing children and preserves unrelated cached branches', async () => {
		const missing = `${root}Draft 草稿 📝/`
		let rootReads = 0
		vi.mocked(getDirectoryContents).mockImplementation(async (_s, _t, path) => {
			if (canonical(path) === canonical(root))
				return ++rootReads === 1
					? [stat(folder), stat(missing), stat(sibling)]
					: [stat(sibling)]
			if (canonical(path) === canonical(sibling))
				return [stat(`${sibling}Keep 保留 ✅.md`, false)]
			throw httpError()
		})
		const result = await traversal().traverse()
		expect(rootReads).toBe(2)
		expect(result.map((item) => item.path)).toEqual([
			canonical(sibling),
			`${sibling}Keep 保留 ✅.md`,
		])
		expect(getDirectoryContents).toHaveBeenCalledTimes(5)
	})

	it('retries a still-listed directory and scans its contents', async () => {
		let reads = 0
		vi.mocked(getDirectoryContents).mockImplementation(async (_s, _t, path) => {
			if (canonical(path) === canonical(root)) return [stat(folder)]
			if (++reads === 1) throw httpError()
			return [stat(note, false)]
		})
		expect((await traversal().traverse()).map((item) => item.path)).toContain(
			note,
		)
		expect(reads).toBe(2)
	})

	it('bounds inconsistent responses, persists unresolved paths and resumes after restart', async () => {
		vi.mocked(getDirectoryContents).mockImplementation(async (_s, _t, path) => {
			if (canonical(path) === canonical(root)) return [stat(folder)]
			throw httpError()
		})
		await expect(traversal().traverse()).rejects.toThrow(
			'returned 404 again after suspension',
		)
		expect(getDirectoryContents).toHaveBeenCalledTimes(4)
		expect(cache?.pendingVerification).toEqual([folder])
		expect(await traversal().isCacheValid()).toBe(false)
		vi.mocked(getDirectoryContents).mockImplementation(async (_s, _t, path) =>
			canonical(path) === canonical(root)
				? [stat(folder)]
				: [stat(note, false)],
		)
		expect((await traversal().traverse()).map((item) => item.path)).toContain(
			note,
		)
		expect(await traversal().isCacheValid()).toBe(true)
	})

	it('persists 404 with an empty queue when delta fails, then reconciles after restart', async () => {
		vi.mocked(getLatestDeltaCursor).mockResolvedValue({
			response: { cursor: 'start' },
		})
		vi.mocked(getDirectoryContents).mockImplementation(async (_s, _t, path) => {
			if (canonical(path) === canonical(root)) return [stat(folder)]
			throw httpError()
		})
		vi.mocked(getDelta).mockRejectedValue(new Error('Connection interrupted'))
		await expect(traversal().traverse()).rejects.toThrow(
			'Connection interrupted',
		)
		expect(cache?.queue).toEqual([])
		expect(cache?.pendingVerification).toEqual([folder])
		delta([entry(folder, true)])
		expect(await traversal().traverse()).toEqual([])
	})

	it('scans a directory recreated after deletion instead of accepting an empty delta node', async () => {
		vi.mocked(getLatestDeltaCursor).mockResolvedValue({
			response: { cursor: 'start' },
		})
		delta([entry(folder, true), entry(folder, false)])
		let reads = 0
		vi.mocked(getDirectoryContents).mockImplementation(async (_s, _t, path) => {
			if (canonical(path) === canonical(root)) return [stat(folder)]
			if (++reads === 1) throw httpError()
			return [stat(note, false)]
		})
		expect((await traversal().traverse()).map((item) => item.path)).toContain(
			note,
		)
	})

	it('invalidates cached subtree and rescans new children on same-batch DELETE then ADD of cached directory', async () => {
		const staleNote = `${folder}Stale 旧笔记 🗑️.md`
		const freshNote = `${folder}Fresh 新笔记 🌱.md`
		cache = {
			schemaVersion: TRAVERSAL_CACHE_SCHEMA,
			lastFullScanAt: Date.now(),
			rootCursor: 'start',
			queue: [],
			nodes: {
				[root]: [fileStatToStatModel(stat(folder))],
				[folder]: [fileStatToStatModel(stat(staleNote, false, 'etag-stale'))],
			},
		}
		delta([
			entry(folder, true, { isDir: true, revision: 10 }),
			entry(folder, false, { isDir: true, revision: 11 }),
		])
		vi.mocked(getDirectoryContents).mockResolvedValue([
			stat(freshNote, false, 'etag-fresh'),
		])

		const result = await traversal().traverse()
		expect(result.map((s) => s.path)).toEqual([canonical(folder), freshNote])
		expect(result.find((s) => s.path === staleNote)).toBeUndefined()
		expect(getDirectoryContents).toHaveBeenCalledWith(
			expect.anything(),
			'test-token',
			canonical(folder),
			undefined,
			expect.any(Function),
			expect.any(Function),
		)
	})

	it('invalidates old subtree when a cached directory turns into a file in delta', async () => {
		const nested = `${folder}Nested 子文件 📄.md`
		cache = {
			schemaVersion: TRAVERSAL_CACHE_SCHEMA,
			lastFullScanAt: Date.now(),
			rootCursor: 'start',
			queue: [],
			nodes: {
				[root]: [fileStatToStatModel(stat(folder))],
				[folder]: [fileStatToStatModel(stat(nested, false, 'etag-nested'))],
			},
		}
		delta([entry(folder, false, { isDir: false, size: 88, revision: 20 })])
		vi.mocked(statRemotePath).mockResolvedValueOnce({
			status: 'ok',
			stat: {
				path: canonical(folder),
				basename: '资料 Notes 📚 & 100%',
				isDir: false,
				isDeleted: false,
				size: 88,
				mtime: 1_700_000_000_000,
				etag: 'etag-now-file',
			},
		})

		const result = await traversal().traverse()
		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({
			path: canonical(folder),
			isDir: false,
			etag: 'etag-now-file',
		})
		expect(cache?.nodes[folder]).toBeUndefined()
	})

	it.each([404, 401, 403, 500])(
		'does not suppress root HTTP %s',
		async (status) => {
			vi.mocked(getDirectoryContents).mockRejectedValue(httpError(status))
			await expect(traversal().traverse()).rejects.toThrow(`${status}:`)
			expect(cache?.queue).toEqual([root])
		},
	)

	it('climbs to an existing ancestor when the parent also disappeared', async () => {
		const child = `${folder}Section 小节 🔖/`
		let rootReads = 0
		let parentReads = 0
		vi.mocked(getDirectoryContents).mockImplementation(async (_s, _t, path) => {
			if (canonical(path) === canonical(root))
				return ++rootReads === 1 ? [stat(folder)] : []
			if (canonical(path) === canonical(folder) && ++parentReads === 1)
				return [stat(child)]
			throw httpError()
		})
		expect(await traversal().traverse()).toEqual([])
		expect(cache?.pendingVerification).toEqual([])
	})

	it('discovers children of a new directory during incremental traversal', async () => {
		cache = {
			schemaVersion: TRAVERSAL_CACHE_SCHEMA,
			lastFullScanAt: Date.now(),
			rootCursor: 'start',
			queue: [],
			nodes: { [root]: [] },
		}
		delta([entry(folder, false)])
		vi.mocked(getDirectoryContents).mockResolvedValue([stat(note, false)])
		expect((await traversal().traverse()).map((item) => item.path)).toEqual([
			canonical(folder),
			note,
		])
		expect(getDirectoryContents).toHaveBeenCalledTimes(1)
	})

	it('applies events produced during parent reconciliation before returning', async () => {
		vi.mocked(getLatestDeltaCursor).mockResolvedValueOnce({
			response: { cursor: 'start' },
		})
		let rootReads = 0
		vi.mocked(getDirectoryContents).mockImplementation(async (_s, _t, path) => {
			if (canonical(path) === canonical(root))
				return ++rootReads === 1 ? [stat(folder)] : []
			if (canonical(path) === canonical(sibling))
				return [stat(`${sibling}New 新建 🌱.md`, false)]
			throw httpError()
		})
		vi.mocked(getDelta).mockReset()
		vi.mocked(getDelta)
			.mockResolvedValueOnce({
				response: {
					cursor: 'start',
					reset: false,
					hasMore: false,
					delta: { entry: [] },
				},
			})
			.mockResolvedValueOnce({
				response: {
					cursor: 'next',
					reset: false,
					hasMore: false,
					delta: { entry: [entry(sibling, false)] },
				},
			})
			.mockResolvedValue({
				response: {
					cursor: 'next',
					reset: false,
					hasMore: false,
					delta: { entry: [] },
				},
			})
		expect((await traversal().traverse()).map((item) => item.path)).toContain(
			`${sibling}New 新建 🌱.md`,
		)
	})

	it('persists the applied delta page cursor when the following page fails', async () => {
		cache = {
			schemaVersion: TRAVERSAL_CACHE_SCHEMA,
			lastFullScanAt: Date.now(),
			rootCursor: 'start',
			queue: [],
			nodes: { [root]: [] },
		}
		vi.mocked(getDelta)
			.mockResolvedValueOnce({
				response: {
					cursor: 'page-one',
					reset: false,
					hasMore: true,
					delta: { entry: [entry(folder, false)] },
				},
			})
			.mockRejectedValueOnce(new Error('Next page unavailable'))
		await expect(traversal().traverse()).rejects.toThrow(
			'Next page unavailable',
		)
		expect(cache?.rootCursor).toBe('page-one')
		expect(cache?.queue).toContain(canonical(folder))
		delta([], 'page-one')
		vi.mocked(getDirectoryContents).mockResolvedValue([stat(note, false)])
		expect((await traversal().traverse()).map((item) => item.path)).toContain(
			note,
		)
	})

	it('does not advance page cursor when statRemotePath fails mid-page', async () => {
		cache = {
			schemaVersion: TRAVERSAL_CACHE_SCHEMA,
			lastFullScanAt: Date.now(),
			rootCursor: 'start',
			queue: [],
			nodes: {
				[root]: [fileStatToStatModel(stat(folder))],
				[folder]: [],
			},
		}
		delta([entry(specialNote, false, { isDir: false, size: 15, revision: 5 })])
		vi.mocked(statRemotePath).mockRejectedValueOnce(new Error('Network drop'))

		await expect(traversal().traverse()).rejects.toThrow('Network drop')
		expect(cache?.rootCursor).toBe('start')
		expect(cache?.nodes[folder]).toEqual([])
	})

	it('rejects stalled delta cursor when hasMore is true', async () => {
		cache = {
			schemaVersion: TRAVERSAL_CACHE_SCHEMA,
			lastFullScanAt: Date.now(),
			rootCursor: 'same-cursor',
			queue: [],
			nodes: { [root]: [] },
		}
		vi.mocked(getDelta).mockResolvedValueOnce({
			response: {
				cursor: 'same-cursor',
				reset: false,
				hasMore: true,
				delta: { entry: [] },
			},
		})
		await expect(traversal().traverse()).rejects.toThrow('Delta cursor stalled')
	})

	it('uses revision short-circuit and atomic PROPFIND Depth: 0 without mixing delta.modified', async () => {
		cache = {
			schemaVersion: TRAVERSAL_CACHE_SCHEMA,
			lastFullScanAt: Date.now(),
			rootCursor: 'c1',
			queue: [],
			nodes: {
				[root]: [fileStatToStatModel(stat(folder))],
				[folder]: [
					{
						...(fileStatToStatModel(
							stat(specialNote, false, 'etag-v1'),
						) as Extract<StatModel, { isDir: false }>),
						revision: 7,
					},
				],
			},
		}
		// Same revision -> zero statRemotePath calls, preserves original PROPFIND mtime
		delta(
			[
				entry(specialNote, false, {
					isDir: false,
					size: 12,
					revision: 7,
					modified: '2026-05-05T00:00:00Z',
				}),
			],
			'c2',
		)
		const first = await traversal().traverse()
		expect(statRemotePath).not.toHaveBeenCalled()
		expect(first.find((s) => s.path === specialNote)?.mtime).toBe(
			new Date('2026-01-01T00:00:00Z').valueOf(),
		)

		// New revision -> calls statRemotePath and stores atomic PROPFIND values
		delta(
			[
				entry(specialNote, false, {
					isDir: false,
					size: 999, // stale/different delta size must not overwrite PROPFIND size
					revision: 8,
					modified: '2026-06-06T00:00:00Z',
				}),
			],
			'c3',
		)
		vi.mocked(statRemotePath).mockResolvedValueOnce({
			status: 'ok',
			stat: {
				path: specialNote,
				basename: '进度 100% #1 📘.md',
				isDir: false,
				isDeleted: false,
				size: 42,
				mtime: 1_700_000_000_123,
				etag: 'etag-v2',
			},
		})
		const second = await traversal().traverse()
		expect(statRemotePath).toHaveBeenCalledOnce()
		expect(second.find((s) => s.path === specialNote)).toMatchObject({
			etag: 'etag-v2',
			size: 42,
			mtime: 1_700_000_000_123,
			revision: 8,
		})

		// Missing revision must NEVER short-circuit even if a previous write had no revision
		const noRevEntry: DeltaEntry = {
			path: canonical(specialNote),
			isDeleted: false,
			isDir: false,
			size: 50,
			modified: '2026-07-07T00:00:00Z',
		}
		delta([noRevEntry], 'c4')
		vi.mocked(statRemotePath).mockResolvedValueOnce({
			status: 'ok',
			stat: {
				path: specialNote,
				basename: '进度 100% #1 📘.md',
				isDir: false,
				isDeleted: false,
				size: 50,
				mtime: 1_700_000_000_999,
				etag: 'etag-v3',
			},
		})
		const third = await traversal().traverse()
		expect(statRemotePath).toHaveBeenCalledTimes(2)
		expect(third.find((s) => s.path === specialNote)).toMatchObject({
			etag: 'etag-v3',
			size: 50,
		})
	})

	it('preserves existing cache and cursor when getLatestDeltaCursor fails during delta reset=true', async () => {
		cache = {
			schemaVersion: TRAVERSAL_CACHE_SCHEMA,
			lastFullScanAt: Date.now(),
			rootCursor: 'old-cursor',
			queue: [],
			nodes: {
				[root]: [fileStatToStatModel(stat(note, false, 'etag-keep'))],
			},
		}
		vi.mocked(getDelta).mockReset()
		vi.mocked(getDelta).mockResolvedValueOnce({
			response: {
				cursor: '',
				reset: true,
				hasMore: false,
				delta: { entry: [] },
			},
		})
		vi.mocked(getLatestDeltaCursor).mockRejectedValueOnce(
			new Error('Cursor service unavailable'),
		)

		await expect(traversal().traverse()).rejects.toThrow(
			'Cursor service unavailable',
		)
		expect(cache?.rootCursor).toBe('old-cursor')
		expect(cache?.queue).toEqual([])
		expect(cache?.nodes[root]).toHaveLength(1)
	})

	it('throws when multi-page delta cursor cycles back to an already-seen cursor', async () => {
		cache = {
			schemaVersion: TRAVERSAL_CACHE_SCHEMA,
			lastFullScanAt: Date.now(),
			rootCursor: 'c1',
			queue: [],
			nodes: { [root]: [] },
		}
		vi.mocked(getDelta).mockReset()
		vi.mocked(getDelta)
			.mockResolvedValueOnce({
				response: {
					cursor: 'c2',
					reset: false,
					hasMore: true,
					delta: { entry: [] },
				},
			})
			.mockResolvedValueOnce({
				response: {
					cursor: 'c1',
					reset: false,
					hasMore: true,
					delta: { entry: [] },
				},
			})
		await expect(traversal().traverse()).rejects.toThrow('Delta cursor stalled')
	})

	it('reconciles 404 file write via parent directory instead of trusting a single 404 to delete', async () => {
		cache = {
			schemaVersion: TRAVERSAL_CACHE_SCHEMA,
			lastFullScanAt: Date.now(),
			rootCursor: 'c1',
			queue: [],
			nodes: {
				[root]: [fileStatToStatModel(stat(folder))],
				[folder]: [],
			},
		}
		delta(
			[entry(specialNote, false, { isDir: false, size: 42, revision: 9 })],
			'c2',
		)
		vi.mocked(statRemotePath).mockResolvedValueOnce({ status: 'not-found' })
		// Parent listing reveals the file actually exists now!
		vi.mocked(getDirectoryContents).mockResolvedValueOnce([
			stat(specialNote, false, 'etag-present'),
		])

		const res = await traversal().traverse()
		expect(res.map((s) => s.path)).toEqual([canonical(folder), specialNote])
		expect(cache?.pendingVerification).toEqual([])
	})

	it('triggers periodic full rescan after 24h and records lastFullScanAt on completion', async () => {
		let clockMs = 1_700_000_000_000
		const now = () => clockMs
		vi.mocked(getDirectoryContents).mockResolvedValue([
			stat(note, false, 'etag-1'),
		])
		await traversal({ now }).traverse()
		expect(cache?.lastFullScanAt).toBe(clockMs)

		// Advance 25h: the next traverse re-verifies the tree and stamps completion only at the end.
		clockMs += FULL_RESCAN_INTERVAL_MS + 60_000
		vi.mocked(getDirectoryContents).mockClear()
		vi.mocked(getLatestDeltaCursor).mockResolvedValueOnce({
			response: { cursor: 'fresh-cursor' },
		})
		delta([], 'fresh-cursor')
		vi.mocked(getDirectoryContents).mockResolvedValueOnce([
			stat(note, false, 'etag-acl-shared'),
		])
		const rescanned = await traversal({ now }).traverse()
		expect(getDirectoryContents).toHaveBeenCalledTimes(1)
		expect(rescanned[0]).toMatchObject({ etag: 'etag-acl-shared' })
		expect(cache?.lastFullScanAt).toBe(clockMs)
	})

	it('rebuilds on a delta reset and discards unresolved paths from the old snapshot', async () => {
		cache = {
			schemaVersion: TRAVERSAL_CACHE_SCHEMA,
			lastFullScanAt: Date.now(),
			rootCursor: 'start',
			queue: [],
			pendingVerification: [folder],
			nodes: { [root]: [] },
		}
		vi.mocked(getLatestDeltaCursor).mockResolvedValue({
			response: { cursor: 'next' },
		})
		vi.mocked(getDelta).mockResolvedValueOnce({
			response: {
				cursor: 'next',
				reset: true,
				hasMore: false,
				delta: { entry: [] },
			},
		})
		vi.mocked(getDirectoryContents).mockResolvedValue([])
		expect(await traversal().traverse()).toEqual([])
		expect(cache?.pendingVerification).toEqual([])
		expect(getDirectoryContents).toHaveBeenCalledTimes(1)
	})

	it.each([401, 403, 500])(
		'does not treat child HTTP %s as absence',
		async (status) => {
			vi.mocked(getDirectoryContents)
				.mockResolvedValueOnce([stat(folder)])
				.mockRejectedValue(httpError(status))
			await expect(traversal().traverse()).rejects.toThrow(`${status}:`)
			expect(cache?.pendingVerification).toEqual([])
			expect(cache?.queue).toEqual([canonical(folder)])
		},
	)

	it('detects the same suspended child even when ancestor invalidation cleared its pending state', async () => {
		const child = `${folder}Section 小节 🔖/`
		let parentReads = 0
		vi.mocked(getDirectoryContents).mockImplementation(async (_s, _t, path) => {
			if (canonical(path) === canonical(root)) return [stat(folder)]
			if (canonical(path) === canonical(folder) && ++parentReads % 2 === 1)
				return [stat(child)]
			throw httpError()
		})
		await expect(traversal().traverse()).rejects.toThrow(
			'returned 404 again after suspension',
		)
		expect(getDirectoryContents).toHaveBeenCalledTimes(7)
		expect(cache?.pendingVerification).toEqual([child])
		expect(await traversal().isCacheValid()).toBe(false)
	})

	it('stops ascending when the sync root also returns 404', async () => {
		cache = {
			schemaVersion: TRAVERSAL_CACHE_SCHEMA,
			lastFullScanAt: Date.now(),
			rootCursor: 'start',
			queue: [],
			pendingVerification: [folder],
			nodes: { [root]: [] },
		}
		vi.mocked(getDirectoryContents).mockRejectedValue(httpError())
		await expect(traversal().traverse()).rejects.toThrow('404:')
		expect(getDirectoryContents).toHaveBeenCalledTimes(1)
		expect(cache?.pendingVerification).toEqual([folder])
	})

	it('allows more than three normal scans after delta resets', async () => {
		let cursor = 0
		let resets = 0
		vi.mocked(getLatestDeltaCursor).mockImplementation(async () => ({
			response: { cursor: String(++cursor) },
		}))
		vi.mocked(getDirectoryContents).mockResolvedValue([])
		vi.mocked(getDelta).mockImplementation(async () => ({
			response: {
				cursor: String(cursor),
				reset: resets++ < 4,
				hasMore: false,
				delta: { entry: [] },
			},
		}))
		expect(await traversal().traverse()).toEqual([])
		expect(getDirectoryContents).toHaveBeenCalledTimes(5)
		expect(getDelta).toHaveBeenCalledTimes(5)
		expect(cache?.queue).toEqual([])
	})

	it('allows distinct directories to recover over more than three passes', async () => {
		const directories = Array.from(
			{ length: 6 },
			(_, i) =>
				root +
				Array.from({ length: i + 1 }, (_, j) => `Section 小节 📚 ${j}/`).join(
					'',
				),
		)
		const reads = new Map<string, number>()
		const leaf = `${directories[directories.length - 1]}Example 示例 ✨.md`
		vi.mocked(getDirectoryContents).mockImplementation(async (_s, _t, path) => {
			if (canonical(path) === canonical(root)) return [stat(directories[0])]
			const index = directories.findIndex(
				(dir) => canonical(dir) === canonical(path),
			)
			if (index < 0) throw new Error('Unexpected directory')
			const count = (reads.get(canonical(path)) ?? 0) + 1
			reads.set(canonical(path), count)
			if (count === 1) throw httpError()
			return index + 1 < directories.length
				? [stat(directories[index + 1])]
				: [stat(leaf, false)]
		})
		expect((await traversal().traverse()).map((item) => item.path)).toContain(
			leaf,
		)
		expect(cache?.pendingVerification).toEqual([])
		expect(vi.mocked(getDelta).mock.calls.length).toBeGreaterThan(3)
	})

	it('does not forget a suspended path when delta resets the scan', async () => {
		let cursor = 0
		vi.mocked(getLatestDeltaCursor).mockImplementation(async () => ({
			response: { cursor: String(++cursor) },
		}))
		vi.mocked(getDirectoryContents).mockImplementation(async (_s, _t, path) => {
			if (canonical(path) === canonical(root)) return [stat(folder)]
			throw httpError()
		})
		vi.mocked(getDelta).mockResolvedValue({
			response: {
				cursor: 'reset',
				reset: true,
				hasMore: false,
				delta: { entry: [] },
			},
		})
		await expect(traversal().traverse()).rejects.toThrow(
			'returned 404 again after suspension',
		)
		expect(getDelta).toHaveBeenCalledTimes(1)
		expect(getDirectoryContents).toHaveBeenCalledTimes(4)
		expect(cache?.pendingVerification).toEqual([folder])
	})

	it('skips IDB persistence on zero-change incremental scans while persisting cursor-only advances once', async () => {
		cache = {
			schemaVersion: TRAVERSAL_CACHE_SCHEMA,
			lastFullScanAt: Date.now(),
			rootCursor: 'start',
			queue: [],
			nodes: { [root]: [] },
		}
		delta([], 'start')
		await traversal().traverse()
		expect(traverseWebDAVKV.set).not.toHaveBeenCalled()

		delta([], 'advanced-cursor')
		await traversal().traverse()
		expect(traverseWebDAVKV.set).toHaveBeenCalledTimes(1)
		expect(cache?.rootCursor).toBe('advanced-cursor')
	})

	it('throttles BFS state persistence across many directories and still persists full state on completion and mid-scan error', async () => {
		const dirCount = 120
		const dirs = Array.from(
			{ length: dirCount },
			(_, i) => `${root}分组 Dir ${i}🌱/`,
		)
		vi.mocked(getDirectoryContents).mockImplementation(async (_s, _t, path) => {
			if (canonical(path) === canonical(root)) return dirs.map((d) => stat(d))
			return [stat(`${path}笔记 Note 🌱.md`, false)]
		})

		const result = await traversal().traverse()
		expect(result).toHaveLength(dirCount * 2)
		expect(vi.mocked(traverseWebDAVKV.set).mock.calls.length).toBeLessThan(10)
		expect(cache?.queue).toEqual([])
		expect(Object.keys(cache?.nodes ?? {})).toHaveLength(dirCount + 1)

		cache = undefined
		vi.mocked(traverseWebDAVKV.set).mockClear()
		let visited = 0
		vi.mocked(getDirectoryContents).mockImplementation(async (_s, _t, path) => {
			if (canonical(path) === canonical(root)) return dirs.map((d) => stat(d))
			visited += 1
			if (visited === 25) throw new Error('Transient mid-scan failure')
			return [stat(`${path}笔记 Note 🌱.md`, false)]
		})

		await expect(traversal().traverse()).rejects.toThrow(
			'Transient mid-scan failure',
		)
		expect(traverseWebDAVKV.set).toHaveBeenCalledTimes(1)
		const persistedCache = vi.mocked(traverseWebDAVKV.set).mock.calls[0]?.[1]
		expect(Object.keys(persistedCache?.nodes ?? {})).toHaveLength(25)
		expect(persistedCache?.queue.length).toBe(dirCount - 24)
	})

	it('persists completed directory listings on cancellation under throttling and resumes remaining directories', async () => {
		const dirs = Array.from(
			{ length: 20 },
			(_, i) => `${root}分组 Dir ${i} 🌿/`,
		)
		let cancelled = false
		let reads = 0
		const run = () =>
			new ResumableWebDAVTraversal({
				settings: {} as NutstoreSettings,
				token: 'test-token',
				remoteBaseDir: root,
				kvKey: 'test-cache',
				throwIfCancelled: () => {
					if (cancelled) throw new Error('Traversal cancelled')
				},
			}).traverse()

		vi.mocked(getDirectoryContents).mockImplementation(async (_s, _t, path) => {
			reads += 1
			if (reads === 12) cancelled = true
			if (canonical(path) === canonical(root)) return dirs.map((d) => stat(d))
			return [stat(`${path}笔记 Note 🌱.md`, false)]
		})

		await expect(run()).rejects.toThrow('Traversal cancelled')
		expect(reads).toBe(12)
		expect(Object.keys(cache?.nodes ?? {})).toHaveLength(12)
		expect(cache?.queue).toHaveLength(9)

		cancelled = false
		vi.mocked(getDirectoryContents).mockClear()
		const resumed = await run()
		expect(getDirectoryContents).toHaveBeenCalledTimes(9)
		expect(resumed).toHaveLength(40)
	})

	it('does not write KV on cancellation before any traversal mutation occurs', async () => {
		const cancelBeforeStart = new ResumableWebDAVTraversal({
			settings: {} as NutstoreSettings,
			token: 'test-token',
			remoteBaseDir: root,
			kvKey: 'test-cache',
			throwIfCancelled: () => {
				throw new Error('Cancelled before start')
			},
		})
		await expect(cancelBeforeStart.traverse()).rejects.toThrow(
			'Cancelled before start',
		)
		expect(traverseWebDAVKV.set).not.toHaveBeenCalled()
	})

	it('rejects non-reset delta responses missing cursor even when hasMore is false without corrupting rootCursor', async () => {
		cache = {
			schemaVersion: TRAVERSAL_CACHE_SCHEMA,
			lastFullScanAt: Date.now(),
			rootCursor: 'valid-cursor-1',
			queue: [],
			nodes: {
				[root]: [fileStatToStatModel(stat(note, false, 'etag-1'))],
			},
		}
		vi.mocked(getDelta).mockResolvedValueOnce({
			response: {
				cursor: '',
				reset: false,
				hasMore: false,
				delta: { entry: [] },
			},
		})

		await expect(traversal().traverse()).rejects.toThrow(
			'Delta response missing cursor',
		)
		expect(cache?.rootCursor).toBe('valid-cursor-1')
	})

	it('persists per-item unreadable PROPFIND paths across incremental runs and clears them when readable again', async () => {
		const restricted = `${folder}Restricted 受限 🔒.md`
		vi.mocked(getDirectoryContents).mockImplementation(
			async (_s, _t, path, _c, _r, onUnreadable) => {
				if (canonical(path) === canonical(root)) return [stat(folder)]
				if (canonical(path) === canonical(folder)) {
					onUnreadable?.({
						path: restricted,
						status: 'HTTP/1.1 403 Forbidden',
					})
					return [stat(note, false, 'etag-ok')]
				}
				return []
			},
		)

		const firstRun = traversal()
		const firstEntries = await firstRun.traverse()
		expect(firstEntries.map((item) => item.path)).toEqual([
			canonical(folder),
			note,
		])
		expect(firstRun.getUnreadableEntries()).toEqual([
			{
				path: restricted,
				operation: 'stat',
				status: 'HTTP/1.1 403 Forbidden',
			},
		])
		expect(cache?.unreadablePaths).toEqual([
			{
				path: restricted,
				operation: 'stat',
				status: 'HTTP/1.1 403 Forbidden',
			},
		])

		// Incremental run with empty delta must still report the persisted unreadable entry
		const secondRun = traversal()
		await secondRun.traverse()
		expect(secondRun.getUnreadableEntries()).toEqual([
			{
				path: restricted,
				operation: 'stat',
				status: 'HTTP/1.1 403 Forbidden',
			},
		])

		// When delta reports an update and statRemotePath succeeds, protection clears
		delta(
			[entry(restricted, false, { isDir: false, size: 18, revision: 12 })],
			'c2',
		)
		vi.mocked(statRemotePath).mockResolvedValueOnce({
			status: 'ok',
			stat: {
				path: restricted,
				basename: 'Restricted 受限 🔒.md',
				isDir: false,
				isDeleted: false,
				size: 18,
				mtime: 1_700_000_000_000,
				etag: 'etag-restored',
			},
		})
		const thirdRun = traversal()
		const restoredEntries = await thirdRun.traverse()
		expect(thirdRun.getUnreadableEntries()).toEqual([])
		expect(cache?.unreadablePaths).toBeUndefined()
		expect(
			restoredEntries.find((item) => item.path === restricted),
		).toMatchObject({
			etag: 'etag-restored',
		})
	})

	it('aborts when the sync root itself returns a non-200 propstat inside 207 Multi-Status', async () => {
		vi.mocked(getDirectoryContents).mockImplementation(
			async (_s, _t, path, _c, _r, onUnreadable) => {
				onUnreadable?.({
					path: canonical(path),
					status: 'HTTP/1.1 403 Forbidden',
				})
				return []
			},
		)

		await expect(traversal().traverse()).rejects.toThrow(
			'Remote sync root is unreadable',
		)
	})

	it('preserves newly-reported 403 unreadablePaths for a previously cached subdirectory during parent reconciliation', async () => {
		const lockedSub = `${folder}受限子目录 🔒/`
		const lockedChild = `${lockedSub}内部笔记 📄.md`
		cache = {
			schemaVersion: TRAVERSAL_CACHE_SCHEMA,
			lastFullScanAt: Date.now(),
			rootCursor: 'c1',
			queue: [],
			nodes: {
				[root]: [fileStatToStatModel(stat(folder))],
				[folder]: [
					fileStatToStatModel(stat(lockedSub)),
					fileStatToStatModel(stat(specialNote, false, 'etag-v1')),
				],
				[lockedSub]: [fileStatToStatModel(stat(lockedChild, false, 'etag-in'))],
			},
		}
		// Delta update on `specialNote` hits 404 on Depth: 0, triggering parent reconciliation on `folder`
		delta(
			[entry(specialNote, false, { isDir: false, size: 16, revision: 9 })],
			'c2',
		)
		vi.mocked(statRemotePath).mockResolvedValueOnce({ status: 'not-found' })
		vi.mocked(getDirectoryContents).mockImplementationOnce(
			async (_s, _t, path, _c, _r, onUnreadable) => {
				expect(canonical(path)).toBe(canonical(folder))
				onUnreadable?.({
					path: canonical(lockedSub),
					status: 'HTTP/1.1 403 Forbidden',
				})
				return [stat(specialNote, false, 'etag-v2')]
			},
		)

		const run = traversal()
		const items = await run.traverse()
		expect(items.find((item) => item.path === specialNote)).toMatchObject({
			etag: 'etag-v2',
		})
		expect(items.find((item) => item.path === lockedChild)).toBeUndefined()
		expect(run.getUnreadableEntries()).toEqual([
			{
				path: canonical(lockedSub),
				operation: 'stat',
				status: 'HTTP/1.1 403 Forbidden',
			},
		])
		expect(cache?.unreadablePaths).toEqual([
			{
				path: canonical(lockedSub),
				operation: 'stat',
				status: 'HTTP/1.1 403 Forbidden',
			},
		])
		expect(cache?.nodes[lockedSub]).toBeUndefined()
	})

	it('preserves existing cache and unreadablePaths when getLatestDeltaCursor fails during periodic full rescan', async () => {
		let clockMs = 1_700_000_000_000
		const now = () => clockMs
		const restricted = `${folder}受限笔记 🔒.md`
		cache = {
			schemaVersion: TRAVERSAL_CACHE_SCHEMA,
			lastFullScanAt: clockMs,
			rootCursor: 'valid-cursor-1',
			queue: [],
			unreadablePaths: [
				{
					path: restricted,
					operation: 'stat',
					status: 'HTTP/1.1 403 Forbidden',
				},
			],
			nodes: {
				[root]: [fileStatToStatModel(stat(note, false, 'etag-keep'))],
			},
		}

		clockMs += FULL_RESCAN_INTERVAL_MS + 60_000
		vi.mocked(getLatestDeltaCursor).mockRejectedValueOnce(
			new Error('Cursor service timeout'),
		)

		await expect(traversal({ now }).traverse()).rejects.toThrow(
			'Cursor service timeout',
		)
		expect(traverseWebDAVKV.set).not.toHaveBeenCalled()
		expect(cache?.rootCursor).toBe('valid-cursor-1')
		expect(cache?.lastFullScanAt).toBe(1_700_000_000_000)
		expect(cache?.nodes[root]).toHaveLength(1)
		expect(cache?.unreadablePaths).toEqual([
			{
				path: restricted,
				operation: 'stat',
				status: 'HTTP/1.1 403 Forbidden',
			},
		])
	})
})
