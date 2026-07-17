import { deflateSync } from 'fflate/browser'
import superjson from 'superjson'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type NutstorePlugin from '..'
import type { SyncLogger } from '~/sync/log'
import CacheServiceV1, { type ExportedStorage } from './cache.service.v1'

const storage = vi.hoisted(() => ({
	getTraversal: vi.fn(),
	setTraversal: vi.fn(),
	getUploadMeta: vi.fn(),
	setUploadMeta: vi.fn(),
}))

vi.mock('~/storage', () => ({
	traverseWebDAVKV: {
		get: storage.getTraversal,
		set: storage.setTraversal,
	},
	cacheUploadMetaKV: {
		get: storage.getUploadMeta,
		set: storage.setUploadMeta,
	},
}))

const logger = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
} as unknown as SyncLogger

function encodeStorage(value: ExportedStorage): Uint8Array<ArrayBuffer> {
	return deflateSync(new TextEncoder().encode(superjson.stringify(value)), {
		level: 9,
	}) as Uint8Array<ArrayBuffer>
}

function createService(webdav: object, remoteBaseDir = '/vault/') {
	const plugin = {
		remoteBaseDir,
		getToken: vi.fn(async () => 'token'),
		app: { vault: { configDir: '.obsidian' } },
		webDAVService: {
			createWebDAVClient: vi.fn(async () => webdav),
		},
	} as unknown as NutstorePlugin
	return new CacheServiceV1(plugin)
}

describe('CacheServiceV1 remote cache safety', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('accepts legacy cache metadata without a trailing slash', async () => {
		const cachedTraversal = {
			rootCursor: 'cursor',
			queue: [],
			nodes: { '/vault': [] },
		}
		storage.getTraversal.mockResolvedValue(undefined)
		const webdav = {
			exists: vi.fn(async () => true),
			getFileContents: vi.fn(async () =>
				encodeStorage({
					exportedAt: '2026-01-01T00:00:00.000Z',
					remoteBaseDir: '/vault',
					traverseWebDAVCache: cachedTraversal,
				}),
			),
		}

		const restored =
			await createService(webdav).restoreRemoteTraversalCacheIfMissing(logger)

		expect(restored).toBe(true)
		expect(storage.setTraversal).toHaveBeenCalledWith(
			expect.any(String),
			cachedTraversal,
		)
	})

	it('does not record upload metadata when WebDAV reports failure', async () => {
		storage.getTraversal.mockResolvedValue({
			rootCursor: 'cursor',
			queue: [],
			nodes: { '/vault': [] },
		})
		const webdav = {
			exists: vi.fn(async () => false),
			createDirectory: vi.fn(async () => undefined),
			putFileContents: vi.fn(async () => false),
		}

		const saved = await createService(webdav).saveRemoteTraversalCache(logger)

		expect(saved).toBe(false)
		expect(storage.setUploadMeta).not.toHaveBeenCalled()
		expect(logger.error).toHaveBeenCalled()
	})
})
