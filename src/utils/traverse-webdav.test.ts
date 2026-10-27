import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileStat } from 'webdav'
import type { RequestUrlResponse } from 'obsidian'
import type { DeltaEntry } from '~/api/delta'
import { getDelta } from '~/api/delta'
import { getLatestDeltaCursor } from '~/api/latestDeltaCursor'
import { getDirectoryContents } from '~/api/webdav'
import type { NutstoreSettings } from '~/settings'
import { traverseWebDAVKV, type TraverseWebDAVCache } from '~/storage'
import { RequestUrlError } from './request-url-error'
import { ResumableWebDAVTraversal } from './traverse-webdav'

vi.mock('~/api/delta', () => ({ getDelta: vi.fn() }))
vi.mock('~/api/latestDeltaCursor', () => ({ getLatestDeltaCursor: vi.fn() }))
vi.mock('~/api/webdav', () => ({ getDirectoryContents: vi.fn() }))
vi.mock('~/storage', () => ({
	traverseWebDAVKV: { get: vi.fn(), set: vi.fn(), unset: vi.fn() },
}))
vi.mock('./api-limiter', () => ({
	apiLimiter: { wrap: <T>(fn: T) => fn, schedule: <T>(fn: () => T) => fn() },
}))
vi.mock('./logger', () => ({
	default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

const root = '/Workspace/'
const folder = `${root}资料 Notes 📚 & 100%/`
const sibling = `${root}Archive 归档 🗂️/`
const note = `${folder}Example 示例 ✨.md`
const canonical = (path: string) => path.replace(/\/$/, '')
function stat(path: string, dir = true): FileStat {
	return {
		filename: canonical(path),
		basename: canonical(path).split('/').pop()!,
		type: dir ? 'directory' : 'file',
		size: 0,
		lastmod: '2026-01-01T00:00:00Z',
		etag: null,
	}
}
function entry(path: string, isDeleted: boolean): DeltaEntry {
	return {
		path: canonical(path),
		isDeleted,
		isDir: true,
		size: 0,
		modified: '2026-01-01T00:00:00Z',
		revision: 1,
	}
}
function httpError(status = 404) {
	return new RequestUrlError({
		status,
		text: 'Resource unavailable',
	} as RequestUrlResponse)
}
function traversal() {
	return new ResumableWebDAVTraversal({
		settings: {} as NutstoreSettings,
		token: 'test-token',
		remoteBaseDir: root,
		kvKey: 'test-cache',
	})
}
let cache: TraverseWebDAVCache | undefined
function delta(entries: DeltaEntry[], cursor = 'next') {
	vi.mocked(getDelta).mockResolvedValue({
		response: {
			cursor,
			reset: false,
			hasMore: false,
			delta: { entry: entries },
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
	vi.mocked(getLatestDeltaCursor).mockResolvedValue({
		response: { cursor: 'start' },
	})
	delta([], 'start')
})

describe('remote traversal recovery', () => {
	it('finishes siblings and lets delta delete a missing directory without rescanning', async () => {
		vi.mocked(getLatestDeltaCursor)
			.mockResolvedValueOnce({ response: { cursor: 'start' } })
			.mockResolvedValue({ response: { cursor: 'next' } })
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
		// Two failed reads of the same directory, with one parent verification.
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
		vi.mocked(getLatestDeltaCursor)
			.mockResolvedValueOnce({ response: { cursor: 'start' } })
			.mockResolvedValue({ response: { cursor: 'next' } })
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
		vi.mocked(getLatestDeltaCursor)
			.mockResolvedValueOnce({ response: { cursor: 'start' } })
			.mockResolvedValue({ response: { cursor: 'next' } })
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
		cache = { rootCursor: 'start', queue: [], nodes: { [root]: [] } }
		delta([entry(folder, false)])
		vi.mocked(getLatestDeltaCursor).mockResolvedValue({
			response: { cursor: 'next' },
		})
		vi.mocked(getDirectoryContents).mockResolvedValue([stat(note, false)])
		expect((await traversal().traverse()).map((item) => item.path)).toEqual([
			canonical(folder),
			note,
		])
		expect(getDirectoryContents).toHaveBeenCalledTimes(1)
	})

	it('applies events produced during parent reconciliation before returning', async () => {
		vi.mocked(getLatestDeltaCursor)
			.mockResolvedValueOnce({ response: { cursor: 'start' } })
			.mockResolvedValueOnce({ response: { cursor: 'start' } })
			.mockResolvedValue({ response: { cursor: 'next' } })
		let rootReads = 0
		vi.mocked(getDirectoryContents).mockImplementation(async (_s, _t, path) => {
			if (canonical(path) === canonical(root))
				return ++rootReads === 1 ? [stat(folder)] : []
			if (canonical(path) === canonical(sibling))
				return [stat(`${sibling}New 新建 🌱.md`, false)]
			throw httpError()
		})
		delta([entry(sibling, false)])
		expect((await traversal().traverse()).map((item) => item.path)).toContain(
			`${sibling}New 新建 🌱.md`,
		)
	})

	it('persists the applied delta page cursor when the following page fails', async () => {
		cache = { rootCursor: 'start', queue: [], nodes: { [root]: [] } }
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
		vi.mocked(getLatestDeltaCursor).mockResolvedValue({
			response: { cursor: 'page-one' },
		})
		vi.mocked(getDirectoryContents).mockResolvedValue([stat(note, false)])
		expect((await traversal().traverse()).map((item) => item.path)).toContain(
			note,
		)
	})

	it('rebuilds on a delta reset and discards unresolved paths from the old snapshot', async () => {
		cache = {
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
		expect(vi.mocked(getLatestDeltaCursor).mock.calls.length).toBeGreaterThan(3)
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
})
