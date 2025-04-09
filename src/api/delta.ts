import { XMLParser } from 'fast-xml-parser'
import { isNil } from 'lodash-es'
import { apiLimiter } from '~/utils/api-limiter'
import { NSAPI } from '~/utils/ns-api'
import requestUrl from '~/utils/request-url'

export interface DeltaEntry {
	path: string
	size: number
	isDeleted: boolean
	isDir: boolean
	modified: string
	revision: number
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
	token: string
}

export const getDelta = apiLimiter.wrap(
	async ({ folderName, cursor, token }: GetDeltaInput) => {
		const body = `<?xml version="1.0" encoding="utf-8"?>
              <s:delta xmlns:s="http://ns.jianguoyun.com">
                  <s:folderName>${folderName}</s:folderName>
                  <s:cursor>${cursor ?? ''}</s:cursor>
              </s:delta>`
		const response = await requestUrl({
			url: NSAPI('delta'),
			method: 'POST',
			headers: {
				Authorization: `Basic ${token}`,
				'Content-Type': 'application/xml',
			},
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
		})
		const result: { response: DeltaResponse } = parseXml.parse(response.text)

		if (!isNil(result?.response?.cursor)) {
			result.response.cursor = result.response.cursor.toString()
		}
		if (result.response.delta) {
			const entry = result.response.delta.entry
			if (!Array.isArray(entry)) {
				result.response.delta.entry = [entry]
			}
		} else {
			result.response.delta = {
				entry: [],
			}
		}
		return result
	},
)
