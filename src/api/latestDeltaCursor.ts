import { XMLParser } from 'fast-xml-parser'
import type { NutstoreSettings } from '~/settings'
import { apiLimiter } from '~/utils/api-limiter'
import { escapeXmlText } from '~/utils/escape-xml-text'
import { NSAPI } from '~/utils/ns-api'
import requestUrl from '~/utils/request-url'
import { xmlTextValue } from '~/utils/xml-text-value'

interface GetLatestDeltaCursorInput {
	folderName: string
	settings: NutstoreSettings
	token: string
	throwIfCancelled?: () => void
}

export const getLatestDeltaCursor = apiLimiter.wrap(
	async ({
		folderName,
		settings,
		token,
		throwIfCancelled,
	}: GetLatestDeltaCursorInput) => {
		throwIfCancelled?.()
		const body = `<?xml version="1.0" encoding="utf-8"?>
<s:delta xmlns:s="http://ns.jianguoyun.com">
  <s:folderName>${escapeXmlText(folderName)}</s:folderName>
</s:delta>`
		const headers = {
			Authorization: `Basic ${token}`,
			'Content-Type': 'application/xml',
		}
		const response = await requestUrl({
			url: NSAPI(settings, 'latestDeltaCursor'),
			method: 'POST',
			headers,
			body,
		})
		throwIfCancelled?.()
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
		const result = parseXml.parse(response.text) as {
			response?: {
				cursor?: unknown
			}
		}
		if (!result?.response || typeof result.response !== 'object') {
			throw new Error(
				'Invalid latestDeltaCursor XML response: missing <response> root',
			)
		}
		const cursor = xmlTextValue(result.response.cursor)
		if (!cursor) {
			throw new Error('Invalid latestDeltaCursor XML response: missing cursor')
		}
		return {
			response: {
				cursor,
			},
		}
	},
)
