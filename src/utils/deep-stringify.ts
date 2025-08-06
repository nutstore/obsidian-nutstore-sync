import {
	isArray,
	isBoolean,
	isDate,
	isError,
	isFinite,
	isFunction,
	isNull,
	isNumber,
	isRegExp,
	isString,
	isSymbol,
	isUndefined,
	map,
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
		throw new TypeError('Do not know how to serialize a BigInt')
	}
	if (isRegExp(value)) {
		return JSON.stringify(String(value))
	}
	// Handle Date objects explicitly
	if (isDate(value)) {
		if (isFinite(value.getTime())) {
			// Stringify the ISO string to get the required quotes
			return JSON.stringify(value.toISOString())
		} else {
			return 'null' // Invalid date becomes null
		}
	}
	if (isError(value)) {
		return JSON.stringify({
			type: 'Error',
			value: value?.toString() ?? { name: value.name, message: value.message },
		})
	}

	// --- Value should be an Array or an Object-like entity ---

	// Ensure value is object type before circular check / adding to Set<object>
	if (typeof value !== 'object' || value === null) {
		throw new Error(
			`Internal error: Unexpected non-object type: ${typeof value}`,
		)
	}

	// 2. Circular reference check
	if (visited.has(value)) {
		throw new TypeError('Converting circular structure to JSON')
	}
	visited.add(value) // Add current object/array *before* recursive calls

	let result: string | undefined

	try {
		// 3. Handle Arrays using _.map
		if (isArray(value)) {
			const elements = map(value, (element: unknown): string => {
				const stringifiedElement = deepStringify(element, visited)
				// JSON spec: undefined/function/symbol array elements become null
				return stringifiedElement === undefined ? 'null' : stringifiedElement
			})
			result = `[${elements.join(',')}]`
		}
		// 4. Handle Objects using Object.keys().forEach()
		else {
			// Should be an object type here
			const keys = Object.keys(value) // Get own enumerable string keys
			const properties: string[] = [] // Array to hold "key:value" strings

			keys.forEach((key) => {
				let stringifiedValue: string | undefined
				try {
					// *** Access the property inside try block ***
					// Use Record<string, unknown> assertion as TS doesn't know about arbitrary keys/getters
					const currentValue = (value as Record<string, unknown>)[key]
					stringifiedValue = deepStringify(currentValue, visited) // Recurse
				} catch (error: unknown) {
					// *** Handle getter error: stringify the error message ***
					let errorMessage = 'Error accessing property'
					if (error instanceof Error) {
						errorMessage = error.message
					} else if (
						typeof error === 'object' &&
						error !== null &&
						'message' in error &&
						typeof error.message === 'string'
					) {
						// Handle plain objects thrown with a message property
						errorMessage = error.message
					} else {
						try {
							errorMessage = String(error)
						} catch {
							/* ignore */
						}
					}
					// Use native stringify to quote and escape the error message string
					stringifiedValue = JSON.stringify(errorMessage)
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
		visited.delete(value)
	}

	return result
}
