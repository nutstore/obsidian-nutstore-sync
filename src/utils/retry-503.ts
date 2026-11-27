import { is503Error } from './is-503-error'
import logger from './logger'
import sleep from './sleep'
import type { MaybePromise } from './types'

const DEFAULT_INITIAL_DELAY_MS = 1_000
const DEFAULT_MAX_DELAY_MS = 300_000
const CANCEL_POLL_SLICE_MS = 250

export interface Retry503Options {
	throwIfCancelled?: () => void
	onRetry?: (attempt: number, delayMs: number) => void
	initialDelayMs?: number
	maxDelayMs?: number
}

/**
 * Retries transient 503 / `ServiceUnAvailable` errors with cancellable exponential
 * backoff. Callers must wrap `apiLimiter.schedule(...)` from the outside so
 * rate-limit slots are released while waiting.
 */
export async function retryWith503Backoff<T>(
	fn: () => MaybePromise<T>,
	options: Retry503Options = {},
): Promise<T> {
	const initialDelayMs = Math.max(
		1,
		options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
	)
	const maxDelayMs = Math.max(
		initialDelayMs,
		options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
	)
	let attempt = 0
	let delayMs = initialDelayMs

	while (true) {
		options.throwIfCancelled?.()
		try {
			return await fn()
		} catch (error) {
			if (!is503Error(error)) {
				throw error
			}
			attempt += 1
			options.onRetry?.(attempt, delayMs)
			logger.warn(
				`Nutstore 503 Service Unavailable, retry #${attempt} in ${delayMs}ms`,
			)
			let waited = 0
			while (waited < delayMs) {
				options.throwIfCancelled?.()
				const slice = Math.min(CANCEL_POLL_SLICE_MS, delayMs - waited)
				await sleep(slice)
				waited += slice
			}
			delayMs = Math.min(delayMs * 2, maxDelayMs)
		}
	}
}
