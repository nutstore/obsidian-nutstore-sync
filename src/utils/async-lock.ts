import { Mutex as ToolkitMutex } from 'es-toolkit'

/**
 * Mutual exclusion lock backed by `es-toolkit`'s `Mutex` (sharing the same
 * `Semaphore` primitive already bundled via `limitAsync`).
 *
 * Adds idempotent releasers, `runExclusive`, and `waitForUnlock` so callers
 * do not need a separate `async-mutex` package.
 */
export class AsyncMutex {
	private readonly mutex = new ToolkitMutex()
	private unlockWaiters: Array<() => void> = []

	isLocked(): boolean {
		return this.mutex.isLocked
	}

	async acquire(): Promise<() => void> {
		await this.mutex.acquire()
		let released = false
		return () => {
			if (released) return
			released = true
			this.mutex.release()
			if (!this.mutex.isLocked && this.unlockWaiters.length > 0) {
				const waiters = this.unlockWaiters
				this.unlockWaiters = []
				for (const resolve of waiters) resolve()
			}
		}
	}

	async runExclusive<T>(work: () => Promise<T> | T): Promise<T> {
		const release = await this.acquire()
		try {
			return await work()
		} finally {
			release()
		}
	}

	async waitForUnlock(): Promise<void> {
		if (!this.mutex.isLocked) return
		await new Promise<void>((resolve) => {
			this.unlockWaiters.push(resolve)
		})
	}
}
