import { createAbortError, throwIfAborted } from './abort'

export function raceWithAbort<T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	throwIfAborted(signal)
	if (!signal) {
		return promise
	}

	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			cleanup()
			reject(
				signal.reason instanceof Error ? signal.reason : createAbortError(),
			)
		}

		const cleanup = () => {
			signal.removeEventListener('abort', onAbort)
		}

		signal.addEventListener('abort', onAbort, { once: true })
		promise.then(
			(value) => {
				cleanup()
				resolve(value)
			},
			(error) => {
				cleanup()
				reject(error)
			},
		)
	})
}
