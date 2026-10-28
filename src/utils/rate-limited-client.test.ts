import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebDAVClient } from 'webdav'
import { throwIfAborted } from './abort'
import { createRateLimitedWebDAVClient } from './rate-limited-client'

const { schedule } = vi.hoisted(() => ({ schedule: vi.fn() }))
vi.mock('./api-limiter', () => ({ apiLimiter: { schedule } }))

beforeEach(() => {
	schedule.mockReset()
})

describe('cancelled WebDAV work', () => {
	it.each(['notes/example.txt', '笔记/示例🌿.txt'])(
		'does not send a queued upload after cancellation: %s',
		async (path) => {
			let dispatch!: () => Promise<unknown>
			schedule.mockImplementation(
				(work) =>
					new Promise((resolve, reject) => {
						dispatch = () => work().then(resolve, reject)
					}),
			)
			const cancellation = new AbortController()
			const upload = vi.fn(async () => true)
			const client = createRateLimitedWebDAVClient(
				{ putFileContents: upload } as unknown as WebDAVClient,
				() => throwIfAborted(cancellation.signal),
			)
			const work = client.putFileContents(path, new ArrayBuffer(0))
			const rejected = expect(work).rejects.toMatchObject({
				name: 'AbortError',
			})
			cancellation.abort()
			await dispatch()
			await rejected
			expect(upload).not.toHaveBeenCalled()
		},
	)

	it('waits for an already sent request and rejects its late result after cancellation', async () => {
		schedule.mockImplementation((work) => work())
		let finish!: (value: boolean) => void
		const cancellation = new AbortController()
		const client = createRateLimitedWebDAVClient(
			{
				putFileContents: () =>
					new Promise((resolve) => {
						finish = resolve
					}),
			} as unknown as WebDAVClient,
			() => throwIfAborted(cancellation.signal),
		)
		const settled = vi.fn()
		const work = client.putFileContents('notes/示例🌿.txt', new ArrayBuffer(0))
		void work.then(settled, settled)
		cancellation.abort()
		await Promise.resolve()
		expect(settled).not.toHaveBeenCalled()
		finish(true)
		await expect(work).rejects.toMatchObject({ name: 'AbortError' })
	})
})
