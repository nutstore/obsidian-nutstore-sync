export function createAbortError(reason = 'Aborted') {
	if (typeof DOMException !== 'undefined') {
		return new DOMException(reason, 'AbortError')
	}
	const error = new Error(reason)
	error.name = 'AbortError'
	return error
}

export function isAbortError(error: unknown) {
	return error instanceof Error && error.name === 'AbortError'
}

export function throwIfAborted(signal?: AbortSignal) {
	if (signal?.aborted) {
		throw signal.reason instanceof Error
			? signal.reason
			: createAbortError(
					typeof signal.reason === 'string' ? signal.reason : undefined,
				)
	}
}
