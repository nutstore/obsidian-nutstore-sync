import { XMLParser } from 'fast-xml-parser'
import { decode as decodeHtmlEntities } from 'html-entities'
import { RequestUrlError } from './request-url-error'

interface NutstoreDavErrorDetail {
	exception: string
	message?: string
}

const xmlParser = new XMLParser({
	attributeNamePrefix: '',
	removeNSPrefix: true,
	parseTagValue: false,
	processEntities: false,
})

function extractXmlFragment(text: string): string | null {
	const start = text.indexOf('<')
	if (start === -1) return null
	return text.slice(start)
}

/** Parses Nutstore `<d:error><s:exception>` XML payloads safely across plain-text errors. */
function parseNutstoreDavError(
	text: string | undefined,
): NutstoreDavErrorDetail | null {
	if (!text) return null
	const xml = extractXmlFragment(text)
	if (!xml) return null
	try {
		const parsed = xmlParser.parse(xml) as {
			error?: {
				exception?: unknown
				message?: unknown
			}
		}
		const err = parsed?.error
		if (!err || typeof err !== 'object') return null
		if (typeof err.exception !== 'string' || err.exception.length === 0) {
			return null
		}
		return {
			exception: decodeHtmlEntities(err.exception, { level: 'xml' }),
			message:
				typeof err.message === 'string'
					? decodeHtmlEntities(err.message, { level: 'xml' })
					: undefined,
		}
	} catch {
		return null
	}
}

function readCandidateStatus(value: unknown): number | undefined {
	if (value instanceof RequestUrlError) {
		return value.res.status
	}
	if (typeof value === 'object' && value !== null) {
		const status = Reflect.get(value, 'status')
		if (typeof status === 'number') return status
		const response = Reflect.get(value, 'response')
		if (typeof response === 'object' && response !== null) {
			const responseStatus = Reflect.get(response, 'status')
			if (typeof responseStatus === 'number') return responseStatus
		}
	}
	if (value instanceof Error) {
		const match = /\bInvalid response:\s*(\d{3})\b/.exec(value.message)
		if (match) return Number(match[1])
	}
	return undefined
}

/** Walks wrapped errors (`TaskError`, `cause`) to find the underlying HTTP status code. */
export function extractHttpStatus(error: unknown): number | undefined {
	let current: unknown = error
	const seen = new Set<unknown>()
	while (current !== undefined && current !== null && !seen.has(current)) {
		seen.add(current)
		const status = readCandidateStatus(current)
		if (status !== undefined) return status
		if (typeof current === 'object') {
			current = Reflect.get(current, 'cause')
		} else {
			break
		}
	}
	return undefined
}

/** Walks wrapped errors (`TaskError`, `cause`) to extract Nutstore `<s:exception>`. */
export function extractNutstoreDavException(
	error: unknown,
): string | undefined {
	let current: unknown = error
	const seen = new Set<unknown>()
	while (current !== undefined && current !== null && !seen.has(current)) {
		seen.add(current)
		if (current instanceof RequestUrlError) {
			const parsed = parseNutstoreDavError(current.res.text)
			if (parsed) return parsed.exception
		}
		if (typeof current === 'object') {
			const message = Reflect.get(current, 'message')
			if (typeof message === 'string') {
				const parsed = parseNutstoreDavError(message)
				if (parsed) return parsed.exception
			}
			current = Reflect.get(current, 'cause')
		} else if (typeof current === 'string') {
			return parseNutstoreDavError(current)?.exception
		} else {
			break
		}
	}
	return undefined
}
