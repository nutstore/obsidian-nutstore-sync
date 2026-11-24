export interface Deferred<T = void> {
	readonly promise: Promise<T>
	resolve: (value: T | PromiseLike<T>) => void
	reject: (reason?: unknown) => void
	readonly settled: boolean
}

export function createDeferred<T = void>(): Deferred<T> {
	let settled = false
	let resolveFn!: (value: T | PromiseLike<T>) => void
	let rejectFn!: (reason?: unknown) => void
	const promise = new Promise<T>((resolve, reject) => {
		resolveFn = (value) => {
			settled = true
			resolve(value)
		}
		rejectFn = (reason) => {
			settled = true
			reject(reason instanceof Error ? reason : new Error(String(reason)))
		}
	})
	return {
		promise,
		resolve: resolveFn,
		reject: rejectFn,
		get settled() {
			return settled
		},
	}
}

const nativeSetImmediate =
	typeof setImmediate === 'function' ? setImmediate : undefined

const nextTick = () =>
	new Promise<void>((resolve) =>
		nativeSetImmediate ? nativeSetImmediate(resolve) : queueMicrotask(resolve),
	)

export async function flushMicrotasks(rounds = 8): Promise<void> {
	for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

export async function flushUntil<T>(
	predicate: () => T | Promise<T>,
	options: {
		maxTicks?: number
		microtasksPerTick?: number
		useImmediate?: boolean
	} = {},
): Promise<T> {
	const { maxTicks = 120, microtasksPerTick = 6, useImmediate = true } = options
	let lastError: unknown
	for (let tick = 0; tick < maxTicks; tick += 1) {
		try {
			const value = await predicate()
			if (value !== false) return value
			lastError = new Error('flushUntil predicate returned false')
		} catch (error) {
			lastError = error
		}
		await flushMicrotasks(microtasksPerTick)
		if (useImmediate) await nextTick()
	}
	if (lastError instanceof Error) throw lastError
	throw new Error(
		`flushUntil did not converge within ${maxTicks} ticks: ${String(lastError)}`,
	)
}

export class DeterministicScheduler {
	private readonly queue: Array<{ label: string; run: () => void }> = []

	get pendingCount(): number {
		return this.queue.length
	}

	defer<T>(label: string, produce: () => T): Promise<T> {
		const deferred = createDeferred<T>()
		this.queue.push({
			label,
			run: () => {
				try {
					deferred.resolve(produce())
				} catch (error) {
					deferred.reject(error)
				}
			},
		})
		return deferred.promise
	}

	async stepAt(index: number): Promise<boolean> {
		if (this.queue.length === 0) return false
		const safeIndex =
			((index % this.queue.length) + this.queue.length) % this.queue.length
		this.queue.splice(safeIndex, 1)[0].run()
		await flushMicrotasks()
		return true
	}
}
