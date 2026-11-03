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
} from 'es-toolkit/compat'
import {
	describeThrownValue,
	inspectError,
	isErrorLike,
} from './error-inspection'
// No need to import Set, use built-in TS Set type

/**
 * Deeply stringifies a JavaScript value into a JSON string, similar to JSON.stringify,
 * using compatibility helpers for cross-realm values.
 * - Handles circular references with a stable placeholder.
 * - Handles getter errors by stringifying the error message as the property's value.
 * - Retains Error causes, aggregate members, and own diagnostic properties.
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
	if (isErrorLike(value)) {
		return stringifyErrorObject(value, visited)
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
						`Error accessing property: ${describeThrownValue(error)}`,
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

function stringifyErrorObject(error: object, visited: Set<object>): string {
	if (visited.has(error)) return JSON.stringify('[Circular]')
	visited.add(error)

	try {
		const inspection = inspectError(error)
		const serialized: string[] = [
			`"name":${JSON.stringify(inspection.name)}`,
			`"message":${JSON.stringify(inspection.message)}`,
		]

		if (inspection.stack !== undefined) {
			serialized.push(`"stack":${JSON.stringify(inspection.stack)}`)
		}
		if (inspection.propertiesReadError !== undefined) {
			serialized.push(
				`"propertiesError":${deepStringify(
					`[Could not inspect error properties: ${describeThrownValue(
						inspection.propertiesReadError,
					)}]`,
					visited,
				)}`,
			)
		}

		for (const property of inspection.properties) {
			const value =
				property.readError === undefined
					? property.value
					: `[Thrown while reading property: ${describeThrownValue(
							property.readError,
						)}]`
			const stringifiedValue =
				deepStringify(value, visited) ?? stringifyUnsupportedValue(value)
			serialized.push(`${JSON.stringify(property.key)}:${stringifiedValue}`)
		}

		if (inspection.hasCause) {
			const cause =
				inspection.causeReadError === undefined
					? inspection.cause
					: `[Thrown while reading cause: ${describeThrownValue(
							inspection.causeReadError,
						)}]`
			serialized.push(
				`"cause":${
					deepStringify(cause, visited) ??
					JSON.stringify(`[Unsupported cause: ${typeof cause}]`)
				}`,
			)
		}

		return `{${serialized.join(',')}}`
	} finally {
		visited.delete(error)
	}
}

function stringifyUnsupportedValue(value: unknown): string {
	return JSON.stringify(
		value === undefined ? 'undefined' : `[Unsupported value: ${typeof value}]`,
	)
}

function stringifyInspectionError(error: unknown, label: string): string {
	return JSON.stringify(
		`[Unserializable ${label}: ${describeThrownValue(error)}]`,
	)
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
