import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NutstoreSettings } from '~/settings'
import { ResumableWebDAVTraversal } from './traverse-webdav'

const mocks = vi.hoisted(() => ({
	getDirectoryContents: vi.fn(),
	getLatestDeltaCursor: vi.fn(),
	getCache: vi.fn(),
	setCache: vi.fn(),
}))

vi.mock('~/api/latestDeltaCursor', () => ({
	getLatestDeltaCursor: mocks.getLatestDeltaCursor,
}))

vi.mock('~/api/webdav', () => ({
	getDirectoryContents: mocks.getDirectoryContents,
}))

vi.mock('~/storage', () => ({
	traverseWebDAVKV: {
		get: mocks.getCache,
		set: mocks.setCache,
		unset: vi.fn(),
	},
}))

vi.mock('./api-limiter', () => ({
	apiLimiter: { wrap: <T extends (...args: never[]) => unknown>(fn: T) => fn },
}))

vi.mock('./file-stat-to-stat-model', () => ({
	fileStatToStatModel: (item: unknown) => item,
}))

describe('ResumableWebDAVTraversal progress', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getCache.mockResolvedValue(undefined)
		mocks.setCache.mockResolvedValue(undefined)
		mocks.getLatestDeltaCursor.mockResolvedValue({
			response: { cursor: 'stable-cursor' },
		})
	})

	it('reports neutral English and Chinese paths during a full traversal', async () => {
		mocks.getDirectoryContents.mockImplementation(
			async (_settings: NutstoreSettings, _token: string, path: string) => {
				if (path === '/vault/') {
					return [
						{ path: '/vault/notes', basename: 'notes', isDir: true },
						{ path: '/vault/文档', basename: '文档', isDir: true },
					]
				}
				return [
					{
						path: `${path}/example.md`,
						basename: 'example.md',
						isDir: false,
					},
				]
			},
		)
		const onProgress = vi.fn()
		const traversal = new ResumableWebDAVTraversal({
			settings: {} as NutstoreSettings,
			token: 'token',
			remoteBaseDir: '/vault/',
			kvKey: 'progress-test',
			onProgress,
		})

		await traversal.traverse()

		expect(onProgress).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: 'scanning',
				currentPath: '/vault/notes',
			}),
		)
		expect(onProgress).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: 'scanning',
				currentPath: '/vault/文档',
			}),
		)
		expect(onProgress).toHaveBeenLastCalledWith(
			expect.objectContaining({
				phase: 'complete',
				processedDirectories: 3,
				discoveredItems: 4,
			}),
		)
	})

	it('checks cancellation before starting remote requests', async () => {
		const traversal = new ResumableWebDAVTraversal({
			settings: {} as NutstoreSettings,
			token: 'token',
			remoteBaseDir: '/vault/',
			kvKey: 'cancel-test',
			throwIfCancelled: () => {
				throw new Error('cancelled')
			},
		})

		await expect(traversal.traverse()).rejects.toThrow('cancelled')
		expect(mocks.getLatestDeltaCursor).not.toHaveBeenCalled()
	})
})
