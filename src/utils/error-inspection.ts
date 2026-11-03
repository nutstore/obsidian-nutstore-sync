const CORE_ERROR_PROPERTIES = new Set(['name', 'message', 'stack', 'cause'])

export interface ErrorPropertyInspection {
	key: string
	value?: unknown
	readError?: unknown
}

export interface ErrorInspection {
	name: string
	message: string
	stack?: string
	hasCause: boolean
	cause?: unknown
	causeReadError?: unknown
	properties: ErrorPropertyInspection[]
	propertiesReadError?: unknown
}

/**
 * Error objects from another realm and DOMException do not reliably satisfy
 * `instanceof Error`, but their string tag still identifies them correctly.
 */
export function isErrorLike(value: unknown): value is object {
	if (value instanceof Error) return true
	if (typeof value !== 'object' || value === null) return false
	try {
		const tag = Object.prototype.toString.call(value)
		return tag === '[object Error]' || tag === '[object DOMException]'
	} catch {
		return false
	}
}

/**
 * Reads an error without trusting property access. Error subclasses and host
 * objects may expose throwing getters or hostile proxies.
 */
export function inspectError(error: object): ErrorInspection {
	const name = readStringProperty(error, 'name', 'Error')
	const message = readStringProperty(error, 'message', '')
	const stack = readOptionalStringProperty(error, 'stack')
	const cause = readCause(error)
	const propertyNames = readPropertyNames(error)
	const properties: ErrorPropertyInspection[] = []

	for (const key of propertyNames.names) {
		if (CORE_ERROR_PROPERTIES.has(key)) continue
		try {
			properties.push({
				key,
				value: Reflect.get(error, key),
			})
		} catch (readError) {
			properties.push({ key, readError })
		}
	}

	return {
		name,
		message,
		stack,
		hasCause: cause.hasCause,
		cause: cause.value,
		causeReadError: cause.readError,
		properties,
		propertiesReadError: propertyNames.readError,
	}
}

export function describeThrownValue(
	error: unknown,
	fallback = 'Unknown error',
): string {
	if (error instanceof Error) {
		try {
			return error.message
		} catch {
			return fallback
		}
	}
	if (typeof error === 'object' && error !== null) {
		try {
			const message = Reflect.get(error, 'message')
			if (typeof message === 'string') return message
		} catch {
			return fallback
		}
	}
	try {
		return String(error)
	} catch {
		return fallback
	}
}

function readStringProperty(
	target: object,
	key: 'name' | 'message',
	fallback: string,
): string {
	try {
		const value = Reflect.get(target, key)
		return typeof value === 'string' ? value : fallback
	} catch (error) {
		return `[Thrown while reading ${key}: ${describeThrownValue(error)}]`
	}
}

function readOptionalStringProperty(
	target: object,
	key: 'stack',
): string | undefined {
	try {
		const value = Reflect.get(target, key)
		if (value === undefined) return undefined
		if (typeof value === 'string') return value
		return `[Non-string ${key}: ${describeThrownValue(value)}]`
	} catch (error) {
		return `[Thrown while reading ${key}: ${describeThrownValue(error)}]`
	}
}

function readCause(error: object): {
	hasCause: boolean
	value?: unknown
	readError?: unknown
} {
	try {
		const cause = Reflect.get(error, 'cause')
		return cause === undefined
			? { hasCause: false }
			: { hasCause: true, value: cause }
	} catch (readError) {
		return { hasCause: true, readError }
	}
}

function readPropertyNames(error: object): {
	names: string[]
	readError?: unknown
} {
	try {
		return { names: Object.getOwnPropertyNames(error) }
	} catch (readError) {
		return { names: [], readError }
	}
}
