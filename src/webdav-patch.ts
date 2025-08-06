/**
 * Patch webdav request to use obsidian's requestUrl
 *
 * reference: https://github.com/remotely-save/remotely-save/blob/34db181af002f8d71ea0a87e7965abc57b294914/src/fsWebdav.ts#L25
 */
import { getReasonPhrase } from 'http-status-codes/build/cjs/utils-functions'
import { Platform, RequestUrlParam } from 'obsidian'
import { RequestOptionsWithState } from 'webdav'
import requestUrl from './utils/request-url'
import { getPatcher } from 'webdav'
import { VALID_REQURL } from '~/consts'

/**
 * https://stackoverflow.com/questions/12539574/
 * @param obj
 * @returns
 */
function objKeyToLower(obj: Record<string, string>) {
	return Object.fromEntries(
		Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]),
	)
}

/**
 * https://stackoverflow.com/questions/32850898/how-to-check-if-a-string-has-any-non-iso-8859-1-characters-with-javascript
 * @param str
 * @returns true if all are iso 8859 1 chars
 */
function onlyAscii(str: string) {
	return !/[^\u0000-\u00ff]/g.test(str)
}

if (VALID_REQURL) {
	getPatcher().patch(
		'request',
		async (options: RequestOptionsWithState): Promise<Response> => {
			const transformedHeaders = objKeyToLower({ ...options.headers })
			delete transformedHeaders['host']
			delete transformedHeaders['content-length']

			const reqContentType =
				transformedHeaders['accept'] ?? transformedHeaders['content-type']

			const retractedHeaders = { ...transformedHeaders }
			if (retractedHeaders.hasOwnProperty('authorization')) {
				retractedHeaders['authorization'] = '<retracted>'
			}

			const p: RequestUrlParam = {
				url: options.url,
				method: options.method,
				body: options.data as string | ArrayBuffer,
				headers: transformedHeaders,
				contentType: reqContentType,
				throw: false,
			}

			let r = await requestUrl(p)

			if (
				r.status === 401 &&
				Platform.isIosApp &&
				!options.url.endsWith('/') &&
				!options.url.endsWith('.md') &&
				options.method.toUpperCase() === 'PROPFIND'
			) {
				p.url = `${options.url}/`
				r = await requestUrl(p)
			}
			const rspHeaders = objKeyToLower({ ...r.headers })
			for (const key in rspHeaders) {
				if (rspHeaders.hasOwnProperty(key)) {
					if (!onlyAscii(rspHeaders[key])) {
						rspHeaders[key] = encodeURIComponent(rspHeaders[key])
					}
				}
			}

			let r2: Response | undefined = undefined
			const statusText = getReasonPhrase(r.status)
			if ([101, 103, 204, 205, 304].includes(r.status)) {
				r2 = new Response(null, {
					status: r.status,
					statusText: statusText,
					headers: rspHeaders,
				})
			} else {
				r2 = new Response(r.arrayBuffer, {
					status: r.status,
					statusText: statusText,
					headers: rspHeaders,
				})
			}

			return r2
		},
	)
}
