import type { LogEntry } from '~/services/logger.service'
import { describeThrownValue } from './error-inspection'
import { formatError } from './format-error'

function isLogEntry(val: unknown): val is LogEntry {
	if (typeof val !== 'object' || val === null) {
		return false
	}
	try {
		const entry = val as Record<string, unknown>
		return (
			typeof entry.timestamp === 'string' &&
			typeof entry.level === 'string' &&
			Array.isArray(entry.args)
		)
	} catch {
		return false
	}
}

function serializeArg(arg: unknown): string {
	try {
		if (typeof arg === 'string') return arg
		return formatError(arg)
	} catch (error) {
		return `[Unserializable log arg: ${describeThrownValue(error)}]`
	}
}

export default function logsStringify(logs: unknown): string | undefined {
	try {
		if (logs === null || logs === undefined) return undefined
		if (typeof logs === 'string') return logs

		if (isLogEntry(logs)) {
			const serializedArgs = safeSerializeArgs(logs.args)
			return `[${logs.timestamp}] [${logs.level}] ${serializedArgs}`
		}

		// Legacy fallback for any old-format entries
		return formatError(logs)
	} catch {
		return formatError(logs)
	}
}

function safeSerializeArgs(args: unknown[]): string {
	try {
		return args.map(serializeArg).join(' ')
	} catch (error) {
		return `[Unserializable log args: ${describeThrownValue(error)}]`
	}
}
