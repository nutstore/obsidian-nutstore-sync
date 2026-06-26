import {
	isBoolean,
	isDate,
	isFinite,
	isFunction,
	isNull,
	isNumber,
	isRegExp,
	isString,
	isSymbol,
	isUndefined,
} from 'lodash-es'
// No need to import Set, use built-in TS Set type

/**
 * Deeply stringifies a JavaScript value into a JSON string, similar to JSON.stringify,
 * leveraging lodash-es functions and written in TypeScript.
 * - Handles circular references by throwing an error.
 * - Handles getter errors by stringifying the error message as the property's value.
 * - Uses native JSON.stringify for robust string escaping.
 * - Handles Date objects by calling toISOString(), mimicking native behavior.
 *
 * @param value The value to stringify (typed as unknown for flexibility).
 * @param visited Used internally to track visited objects/arrays for circular reference detection.
 * @returns The JSON string representation, or undefined if the root value is invalid (function, symbol, undefined).
 */
export default function deepStringify(
	value: unknown,
	visited: Set<object> = new Set(),
): string | undefined {
	if (
		value instanceof String ||
		value instanceof Number ||
		value instanceof Boolean
	) {
		return deepStringify(value.valueOf(), visited)
	}

	// 1. Handle primitives, null, and unsupported types first
	if (isNull(value)) {
		return 'null'
	}
	if (isBoolean(value)) {
		return String(value) // 'true' or 'false'
	}
	if (isString(value)) {
		// Use native JSON.stringify for robust escaping AND quoting
		return JSON.stringify(value)
	}
	if (isNumber(value)) {
		return isFinite(value) ? String(value) : 'null' // Handle NaN/Infinity
	}
	if (isUndefined(value) || isFunction(value) || isSymbol(value)) {
		return undefined // Omitted in objects, null in arrays (handled by caller)
	}
	if (typeof value === 'bigint') {
		return JSON.stringify(`${value}n`)
	}
	if (isRegExp(value)) {
		return JSON.stringify(String(value))
	}
	// Handle Date objects explicitly
	if (isDate(value)) {
		try {
			if (isFinite(value.getTime())) {
				// Stringify the ISO string to get the required quotes
				return JSON.stringify(value.toISOString())
			}
		} catch (error) {
			return stringifyInspectionError(error, 'Date')
		}
		return 'null' // Invalid date becomes null
	}
	if (value instanceof Error) {
		return stringifyErrorObject(value)
	}

	// --- Value should be an Array or an Object-like entity ---

	// Ensure value is object type before circular check / adding to Set<object>
	if (typeof value !== 'object' || value === null) {
		throw new Error(
			`Internal error: Unexpected non-object type: ${typeof value}`,
		)
	}

	const toJSONResult = tryCallToJSON(value)
	if (toJSONResult.called) {
		if (toJSONResult.error !== undefined) {
			return stringifyInspectionError(toJSONResult.error, 'toJSON')
		}
		if (toJSONResult.value !== value) {
			return deepStringify(toJSONResult.value, visited)
		}
	}

	// 2. Circular reference check — replace with sentinel instead of throwing
	if (visited.has(value)) {
		return '"[Circular]"'
	}
	visited.add(value) // Add current object/array *before* recursive calls

	let result: string | undefined

	try {
		// 3. Handle Arrays using _.map
		if (Array.isArray(value)) {
			let length: number
			try {
				length = value.length
			} catch (error) {
				return stringifyInspectionError(error, 'array length')
			}
			const elements: string[] = []
			for (let index = 0; index < length; index += 1) {
				let element: unknown
				try {
					element = value[index]
				} catch (error) {
					elements.push(stringifyInspectionError(error, `array index ${index}`))
					continue
				}
				try {
					const stringifiedElement = deepStringify(element, visited)
					// JSON spec: undefined/function/symbol array elements become null
					elements.push(
						stringifiedElement === undefined ? 'null' : stringifiedElement,
					)
				} catch (error) {
					elements.push(stringifyInspectionError(error, `array index ${index}`))
				}
			}
			result = `[${elements.join(',')}]`
		}
		// 4. Handle Objects using Object.keys().forEach()
		else {
			// Should be an object type here
			let keys: string[]
			try {
				keys = Object.keys(value) // Get own enumerable string keys
			} catch (error) {
				return stringifyInspectionError(error, 'object keys')
			}
			const properties: string[] = [] // Array to hold "key:value" strings

			keys.forEach((key) => {
				let stringifiedValue: string | undefined
				try {
					// *** Access the property inside try block ***
					// Use Record<string, unknown> assertion as TS doesn't know about arbitrary keys/getters
					const currentValue = (value as Record<string, unknown>)[key]
					stringifiedValue = deepStringify(currentValue, visited) // Recurse
				} catch (error: unknown) {
					stringifiedValue = JSON.stringify(
						formatInspectionError(error, 'Error accessing property'),
					)
				}

				// Omit properties whose values stringify to undefined
				if (stringifiedValue !== undefined) {
					// Keys in JSON objects must be strings. Stringify ensures quotes.
					const stringifiedKey = JSON.stringify(key)
					properties.push(`${stringifiedKey}:${stringifiedValue}`)
				}
			}) // end forEach key

			result = `{${properties.join(',')}}`
		}
	} finally {
		// 5. Crucial: Remove from visited set *after* processing children/throwing errors
		try {
			visited.delete(value)
		} catch {
			/* ignore visited cleanup failures */
		}
	}

	return result
}

function stringifyErrorObject(error: Error): string {
	const serialized: Record<string, string> = {}

	serialized.name = safeStringProperty(error, 'name', error.name, 'Error')
	serialized.message = safeStringProperty(error, 'message', error.message, '')

	const stack = safeOptionalStringProperty(error, 'stack')
	if (stack !== undefined) {
		serialized.stack = stack
	}

	return JSON.stringify(serialized)
}

function safeStringProperty(
	target: object,
	key: 'name' | 'message',
	fallback: string,
	defaultValue: string,
): string {
	try {
		const value = (target as Record<string, unknown>)[key]
		return typeof value === 'string' ? value : String(value ?? fallback)
	} catch (error) {
		return `[Thrown while reading ${key}: ${formatInspectionError(error, defaultValue)}]`
	}
}

function safeOptionalStringProperty(
	target: object,
	key: 'stack',
): string | undefined {
	try {
		const value = (target as Record<string, unknown>)[key]
		if (value === undefined) return undefined
		return typeof value === 'string' ? value : String(value)
	} catch (error) {
		return `[Thrown while reading ${key}: ${formatInspectionError(error)}]`
	}
}

function stringifyInspectionError(error: unknown, label: string): string {
	return JSON.stringify(
		`[Unserializable ${label}: ${formatInspectionError(error)}]`,
	)
}

function formatInspectionError(
	error: unknown,
	fallback = 'Unknown error',
): string {
	if (error instanceof Error) {
		return error.message
	}
	if (typeof error === 'object' && error !== null) {
		try {
			const message = (error as Record<string, unknown>).message
			if (typeof message === 'string') {
				return message
			}
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

function tryCallToJSON(
	value: object,
):
	| { called: false }
	| { called: true; value: unknown; error?: undefined }
	| { called: true; value?: undefined; error: unknown } {
	try {
		const toJSON = (value as { toJSON?: unknown }).toJSON
		if (typeof toJSON !== 'function') {
			return { called: false }
		}
		return { called: true, value: toJSON.call(value) }
	} catch (error) {
		return { called: true, error }
	}
}
