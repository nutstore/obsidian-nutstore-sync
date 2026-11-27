import { Mutex, Semaphore } from 'es-toolkit'
import sleep from './sleep'

export interface RateLimiterSettings {
	maxConcurrent?: number
	minTime?: number
}

/**
 * Lightweight concurrency + minimum start-interval limiter built on `es-toolkit`'s
 * `Semaphore` and `Mutex`. Replaces `bottleneck` (~59 KB) for Nutstore API pacing.
 */
export class RateLimiter {
	private maxConcurrent: number
	private minTime: number
	private semaphore: Semaphore
	private readonly pacingLock = new Mutex()
	private nextStartAt = 0

	constructor(options: { maxConcurrent: number; minTime: number }) {
		this.maxConcurrent = Math.max(1, options.maxConcurrent)
		this.minTime = Math.max(0, options.minTime)
		this.semaphore = new Semaphore(this.maxConcurrent)
	}

	updateSettings(settings: RateLimiterSettings): void {
		if (settings.maxConcurrent !== undefined) {
			const nextMax = Math.max(1, settings.maxConcurrent)
			if (nextMax !== this.maxConcurrent) {
				this.maxConcurrent = nextMax
				this.semaphore = new Semaphore(nextMax)
			}
		}
		if (settings.minTime !== undefined) {
			this.minTime = Math.max(0, settings.minTime)
			if (this.minTime === 0) {
				this.nextStartAt = 0
			}
		}
	}

	private async waitForPacingSlot(): Promise<void> {
		if (this.minTime <= 0) return
		await this.pacingLock.acquire()
		try {
			const waitMs = this.nextStartAt - Date.now()
			if (waitMs > 0) {
				await sleep(waitMs)
			}
			this.nextStartAt = Date.now() + this.minTime
		} finally {
			this.pacingLock.release()
		}
	}

	async schedule<T>(work: () => Promise<T> | T): Promise<T> {
		const sem = this.semaphore
		await sem.acquire()
		try {
			await this.waitForPacingSlot()
			return await work()
		} finally {
			sem.release()
		}
	}

	wrap<TArgs extends unknown[], TResult>(
		fn: (...args: TArgs) => Promise<TResult> | TResult,
	): (...args: TArgs) => Promise<TResult> {
		return (...args: TArgs) => this.schedule(() => fn(...args))
	}
}

export const apiLimiter = new RateLimiter({
	maxConcurrent: 1,
	minTime: 200,
})
