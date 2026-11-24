import { describe, expect, it } from 'vitest'
import { AsyncMutex } from './async-lock'

describe('AsyncMutex', () => {
	it('serializes concurrent tasks in FIFO order and releases on error', async () => {
		const mutex = new AsyncMutex()
		const events: string[] = []
		let markFirstStarted!: () => void
		const firstStarted = new Promise<void>((resolve) => {
			markFirstStarted = resolve
		})
		let releaseFirst!: () => void

		const first = mutex.runExclusive(async () => {
			events.push('first:start')
			expect(mutex.isLocked()).toBe(true)
			markFirstStarted()
			await new Promise<void>((resolve) => {
				releaseFirst = resolve
			})
			events.push('first:end')
			return '笔记 🌿'
		})

		const second = mutex
			.runExclusive(async () => {
				events.push('second:error')
				throw new Error('neutral failure')
			})
			.catch((error: Error) => error.message)

		const third = mutex.runExclusive(async () => {
			events.push('third:run')
			return 'ok'
		})

		await firstStarted
		expect(events).toEqual(['first:start'])
		releaseFirst()

		expect(await first).toBe('笔记 🌿')
		expect(await second).toBe('neutral failure')
		expect(await third).toBe('ok')
		expect(mutex.isLocked()).toBe(false)
		expect(events).toEqual([
			'first:start',
			'first:end',
			'second:error',
			'third:run',
		])
	})

	it('waitForUnlock waits until all queued holders complete and release is idempotent', async () => {
		const mutex = new AsyncMutex()
		await mutex.waitForUnlock()

		const release1 = await mutex.acquire()
		let unlocked = false
		const waiting = mutex.waitForUnlock().then(() => {
			unlocked = true
		})

		const acquired2 = mutex.acquire()
		release1()
		// Double release must not corrupt permit count.
		release1()

		const release2 = await acquired2
		await Promise.resolve()
		expect(mutex.isLocked()).toBe(true)
		expect(unlocked).toBe(false)

		release2()
		await waiting
		expect(unlocked).toBe(true)
		expect(mutex.isLocked()).toBe(false)
	})
})
