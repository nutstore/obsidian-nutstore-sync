import deepStringify from '~/utils/deep-stringify'

/** Keep the original diagnostic, including provider response fields and causes. */
export function appError(error: unknown, seen = new Set<unknown>()): string {
	if (typeof error === 'string') return error
	if (!(error instanceof Error)) return deepStringify(error) ?? String(error)
	if (seen.has(error)) return '[Circular]'
	seen.add(error)
	const details = Object.getOwnPropertyNames(error)
		.filter((key) => !['name', 'message', 'stack', 'cause'].includes(key))
		.map((key) => {
			try {
				return `${key}: ${deepStringify(Reflect.get(error, key))}`
			} catch {
				return `${key}: [Unavailable]`
			}
		})
	const cause: unknown = Reflect.get(error, 'cause')
	return [
		error.stack || `${error.name}: ${error.message}`,
		...details,
		cause === undefined ? '' : `Caused by: ${appError(cause, seen)}`,
	]
		.filter(Boolean)
		.join('\n')
}
