import { requestUrl } from 'obsidian'
import { apiLimiter } from '~/utils/api-limiter'
import { NSAPI } from '~/utils/ns-api'
import { parseXml } from '~/utils/parse-xml'

interface GetLatestDeltaCursorInput {
	folderName: string
	token: string
}

export const getLatestDeltaCursor = apiLimiter.wrap(
	async ({ folderName, token }: GetLatestDeltaCursorInput) => {
		const body = `<?xml version="1.0" encoding="utf-8"?>
              <s:delta xmlns:s="http://ns.jianguoyun.com">
                  <s:folderName>${folderName}</s:folderName>
              </s:delta>`
		const headers = {
			Authorization: `Basic ${token}`,
			'Content-Type': 'application/xml',
		}
		const response = await requestUrl({
			url: NSAPI('latestDeltaCursor'),
			method: 'POST',
			headers,
			body,
		})
		const result = parseXml<{
			response: {
				cursor: string
			}
		}>(response.text)
		return result
	},
)
