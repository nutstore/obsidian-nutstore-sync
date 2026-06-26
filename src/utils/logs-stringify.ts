import { LogEntry } from '~/services/logger.service'
import deepStringify from './deep-stringify'

function isLogEntry(val: any): val is LogEntry {
	try {
		return (
			typeof val === 'object' &&
			val !== null &&
			typeof val.timestamp === 'string' &&
			typeof val.level === 'string' &&
			Array.isArray(val.args)
		)
	} catch {
		return false
	}
}

function serializeArg(arg: any): string {
	try {
		if (arg === null) return 'null'
		if (arg === undefined) return 'undefined'
		if (typeof arg === 'string') return arg
		// Handle Error directly to preserve the full stack trace.
		// deepStringify also handles Error, but only preserves name/message/stack as JSON.
		// For log output we prefer the native stack string which is already human-readable.
		if (arg instanceof Error) {
			return safeErrorStack(arg)
		}
		return deepStringify(arg) ?? safeToString(arg)
	} catch (error) {
		return `[Unserializable log arg: ${formatLogError(error)}]`
	}
}

export default function logsStringify(logs: any): string | undefined {
	try {
		if (logs === null || logs === undefined) return undefined
		if (typeof logs === 'string') return logs

		if (isLogEntry(logs)) {
			const serializedArgs = safeSerializeArgs(logs.args)
			return `[${logs.timestamp}] [${logs.level}] ${serializedArgs}`
		}

		// Legacy fallback for any old-format entries
		return deepStringify(logs) ?? safeToString(logs)
	} catch {
		return safeToString(logs)
	}
}

function safeSerializeArgs(args: any[]): string {
	try {
		return args.map(serializeArg).join(' ')
	} catch (error) {
		return `[Unserializable log args: ${formatLogError(error)}]`
	}
}

function safeErrorStack(error: Error): string {
	try {
		if (typeof error.stack === 'string' && error.stack.length > 0) {
			return error.stack
		}
	} catch (stackError) {
		return `[Unserializable error stack: ${formatLogError(stackError)}]`
	}

	let name = 'Error'
	try {
		if (typeof error.name === 'string' && error.name.length > 0) {
			name = error.name
		}
	} catch {
		/* ignore */
	}

	let message = ''
	try {
		if (typeof error.message === 'string') {
			message = error.message
		}
	} catch (messageError) {
		message = `[Thrown while reading message: ${formatLogError(messageError)}]`
	}

	return message ? `${name}: ${message}` : name
}

function safeToString(value: unknown): string {
	try {
		return String(value)
	} catch (error) {
		return `[Unserializable value: ${formatLogError(error)}]`
	}
}

function formatLogError(error: unknown): string {
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
			return 'Unknown error'
		}
	}
	try {
		return String(error)
	} catch {
		return 'Unknown error'
	}
}
