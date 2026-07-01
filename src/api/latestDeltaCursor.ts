import { XMLParser } from 'fast-xml-parser'
import type { NutstoreSettings } from '~/settings'
import { apiLimiter } from '~/utils/api-limiter'
import { NSAPI } from '~/utils/ns-api'
import requestUrl from '~/utils/request-url'

interface GetLatestDeltaCursorInput {
	folderName: string
	settings: NutstoreSettings
	token: string
}

export const getLatestDeltaCursor = apiLimiter.wrap(
	async ({ folderName, settings, token }: GetLatestDeltaCursorInput) => {
		const body = `<?xml version="1.0" encoding="utf-8"?>
              <s:delta xmlns:s="http://ns.jianguoyun.com">
                  <s:folderName>${folderName}</s:folderName>
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
		const result: {
			response: {
				cursor: string
			}
		} = parseXml.parse(response.text)
		return result
	},
)
