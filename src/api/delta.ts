import { XMLParser } from 'fast-xml-parser'
import { decode as decodeHtmlEntities } from 'html-entities'
import type { NutstoreSettings } from '~/settings'
import { apiLimiter } from '~/utils/api-limiter'
import { escapeXmlText } from '~/utils/escape-xml-text'
import { NSAPI } from '~/utils/ns-api'
import requestUrl from '~/utils/request-url'
import { xmlTextValue } from '~/utils/xml-text-value'

export interface DeltaEntry {
	path: string
	size: number
	isDeleted: boolean
	isDir: boolean
	modified: string
	revision?: number
}

export interface DeltaResponse {
	reset: boolean
	cursor: string
	hasMore: boolean
	delta: {
		entry: DeltaEntry[]
	}
}

interface GetDeltaInput {
	folderName: string
	cursor?: string
	settings: NutstoreSettings
	token: string
	throwIfCancelled?: () => void
}

interface RawDeltaEntry {
	path?: unknown
	size?: unknown
	isDeleted?: unknown
	isDir?: unknown
	modified?: unknown
	revision?: unknown
}

interface RawDeltaResponse {
	reset?: unknown
	cursor?: unknown
	hasMore?: unknown
	delta?:
		| ''
		| {
				entry?: RawDeltaEntry | RawDeltaEntry[] | ''
		  }
}

function toBoolean(value: unknown): boolean {
	return value === true || value === 'true'
}

function toNumber(value: unknown): number {
	const num = Number(value)
	return Number.isFinite(num) ? num : 0
}

function toPositiveInt(value: unknown): number | undefined {
	if (value === undefined || value === null || value === '') {
		return undefined
	}
	const num = Number(value)
	return Number.isSafeInteger(num) && num > 0 ? num : undefined
}

/** Parses `/nsdav/delta` XML without coercing hex cursors to numbers or URI-decoding raw paths. */
export function parseDeltaXml(xmlText: string): { response: DeltaResponse } {
	const parseXml = new XMLParser({
		attributeNamePrefix: '',
		removeNSPrefix: true,
		parseTagValue: false,
		numberParseOptions: {
			eNotation: false,
			hex: true,
			leadingZeros: true,
		},
		processEntities: false,
	})
	const parsed = parseXml.parse(xmlText) as {
		response?: RawDeltaResponse
	}
	if (!parsed?.response || typeof parsed.response !== 'object') {
		throw new Error('Invalid delta XML response: missing <response> root')
	}
	const raw = parsed.response

	const rawDelta = raw.delta
	let rawEntries: RawDeltaEntry[] = []
	if (rawDelta && typeof rawDelta === 'object') {
		const rawEntry = rawDelta.entry
		if (Array.isArray(rawEntry)) {
			rawEntries = rawEntry.filter(
				(item): item is RawDeltaEntry =>
					Boolean(item) && typeof item === 'object',
			)
		} else if (rawEntry && typeof rawEntry === 'object') {
			rawEntries = [rawEntry]
		}
	}

	const entries: DeltaEntry[] = rawEntries.map((entry) => ({
		path: decodeHtmlEntities(xmlTextValue(entry.path), { level: 'xml' }),
		size: toNumber(entry.size),
		isDeleted: toBoolean(entry.isDeleted),
		isDir: toBoolean(entry.isDir),
		modified: xmlTextValue(entry.modified),
		revision: toPositiveInt(entry.revision),
	}))

	return {
		response: {
			reset: toBoolean(raw.reset),
			cursor: xmlTextValue(raw.cursor),
			hasMore: toBoolean(raw.hasMore),
			delta: {
				entry: entries,
			},
		},
	}
}

export const getDelta = apiLimiter.wrap(
	async ({
		folderName,
		cursor,
		settings,
		token,
		throwIfCancelled,
	}: GetDeltaInput) => {
		throwIfCancelled?.()
		const cursorTag = cursor
			? `\n  <s:cursor>${escapeXmlText(cursor)}</s:cursor>`
			: ''
		const body = `<?xml version="1.0" encoding="utf-8"?>
<s:delta xmlns:s="http://ns.jianguoyun.com">
  <s:folderName>${escapeXmlText(folderName)}</s:folderName>${cursorTag}
</s:delta>`
		const response = await requestUrl({
			url: NSAPI(settings, 'delta'),
			method: 'POST',
			headers: {
				Authorization: `Basic ${token}`,
				'Content-Type': 'application/xml',
			},
			body,
		})

		throwIfCancelled?.()
		return parseDeltaXml(response.text)
	},
)
