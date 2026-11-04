import deepStringify from './deep-stringify'
import {
	describeThrownValue,
	inspectError,
	isErrorLike,
	type ErrorPropertyInspection,
} from './error-inspection'

/**
 * Formats any value for human-readable logs. Errors retain their native stack,
 * own diagnostics, aggregate members and complete cause chain.
 *
 * Formatting is intentionally lossless. Retention and storage limits belong
 * to the log sink; they must not silently cut an individual diagnostic.
 */
export function formatError(
	error: unknown,
	seen: Set<object> = new Set(),
): string {
	try {
		return formatErrorInternal(error, seen)
	} catch (formattingError) {
		return `[Unserializable error: ${describeThrownValue(formattingError)}]`
	}
}

function formatErrorInternal(error: unknown, seen: Set<object>): string {
	if (typeof error === 'string') return error
	if (!isErrorLike(error)) {
		return stringifyValue(error, seen)
	}
	if (seen.has(error)) return '[Circular]'

	seen.add(error)
	try {
		const inspection = inspectError(error)
		const title = `${inspection.name}: ${inspection.message}`
		const stack = inspection.stack
		const stackIsReadable = stack !== undefined && !stack.startsWith('[')
		const lines: string[] = []
		if (stackIsReadable) {
			if (stack.includes(title)) lines.push(stack)
			else lines.push(title, stack)
		} else {
			lines.push(title)
			if (stack !== undefined) lines.push(stack)
		}

		if (inspection.propertiesReadError !== undefined) {
			lines.push(
				`[Could not inspect error properties: ${describeThrownValue(
					inspection.propertiesReadError,
				)}]`,
			)
		}

		for (const property of inspection.properties) {
			lines.push(...formatProperty(property, seen))
		}

		if (inspection.hasCause) {
			const cause =
				inspection.causeReadError === undefined
					? formatErrorInternal(inspection.cause, seen)
					: `[Thrown while reading cause: ${describeThrownValue(
							inspection.causeReadError,
						)}]`
			lines.push(...withLabel('Caused by', cause))
		}

		return lines.filter(Boolean).join('\n')
	} finally {
		seen.delete(error)
	}
}

function formatProperty(
	property: ErrorPropertyInspection,
	seen: Set<object>,
): string[] {
	if (property.readError !== undefined) {
		return [
			`${property.key}: [Thrown while reading property: ${describeThrownValue(
				property.readError,
			)}]`,
		]
	}
	if (property.key === 'errors' && Array.isArray(property.value)) {
		if (property.value.length === 0) return ['errors: []']
		const lines = ['errors:']
		for (const error of property.value) {
			lines.push(indent(formatErrorInternal(error, seen), 2))
		}
		return lines
	}
	return withLabel(
		property.key,
		isErrorLike(property.value)
			? formatErrorInternal(property.value, seen)
			: stringifyValue(property.value, seen),
	)
}

function withLabel(label: string, value: string): string[] {
	const [first = '', ...rest] = value.split('\n')
	return [`${label}: ${first}`, ...rest.map((line) => indent(line, 2))]
}

function indent(value: string, spaces: number): string {
	const prefix = ' '.repeat(spaces)
	return value
		.split('\n')
		.map((line) => `${prefix}${line}`)
		.join('\n')
}

function stringifyValue(value: unknown, seen: Set<object>): string {
	if (value === undefined) return 'undefined'
	if (typeof value === 'function' || typeof value === 'symbol') {
		return `[Unsupported value: ${typeof value}]`
	}
	return deepStringify(value, seen) ?? safeToString(value)
}

function safeToString(value: unknown): string {
	try {
		return String(value)
	} catch (error) {
		return `[Unserializable value: ${describeThrownValue(error)}]`
	}
}
