import { afterEach, describe, expect, it, vi } from 'vitest'
import { RateLimiter } from './api-limiter'

afterEach(() => {
	vi.useRealTimers()
})

describe('RateLimiter', () => {
	it('enforces maxConcurrent=1 and minTime spacing for schedule and wrap', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))

		const limiter = new RateLimiter({ maxConcurrent: 1, minTime: 200 })
		const timestamps: Array<{ label: string; at: number }> = []
		let active = 0
		let peak = 0

		const run = limiter.wrap(async (label: string) => {
			active++
			peak = Math.max(peak, active)
			timestamps.push({ label, at: Date.now() })
			await new Promise((resolve) => window.setTimeout(resolve, 50))
			active--
			return `done:${label}`
		})

		const p1 = run('笔记')
		const p2 = run('🌿')
		const p3 = limiter.schedule(() => {
			timestamps.push({ label: 'third', at: Date.now() })
			return 'third'
		})

		await vi.advanceTimersByTimeAsync(500)
		expect(await Promise.all([p1, p2, p3])).toEqual([
			'done:笔记',
			'done:🌿',
			'third',
		])
		expect(peak).toBe(1)
		expect(timestamps[1].at - timestamps[0].at).toBeGreaterThanOrEqual(200)
		expect(timestamps[2].at - timestamps[1].at).toBeGreaterThanOrEqual(200)
	})

	it('continues draining after a rejected task and supports updateSettings', async () => {
		const limiter = new RateLimiter({ maxConcurrent: 1, minTime: 200 })
		limiter.updateSettings({ maxConcurrent: 2, minTime: 0 })

		let active = 0
		let peak = 0
		const failed = limiter.schedule(async () => {
			throw new Error('expected failure')
		})
		await expect(failed).rejects.toThrow('expected failure')

		const tasks = [1, 2, 3].map((n) =>
			limiter.schedule(async () => {
				active++
				peak = Math.max(peak, active)
				await Promise.resolve()
				active--
				return n
			}),
		)
		expect(await Promise.all(tasks)).toEqual([1, 2, 3])
		expect(peak).toBe(2)
	})
})
