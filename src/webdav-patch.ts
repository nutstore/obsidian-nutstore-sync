import { getReasonPhrase } from 'http-status-codes/build/cjs/utils-functions'
import { Platform, requestUrl, RequestUrlParam } from 'obsidian'
import { RequestOptionsWithState } from 'webdav'
// @ts-ignore
import { getPatcher } from 'webdav/dist/web/index.js'
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
				// don't ask me why,
				// some webdav servers have some mysterious behaviours,
				// if a folder doesn't exist without slash, the servers return 401 instead of 404
				// here is a dirty hack that works
				console.debug(`so we have 401, try appending request url with slash`)
				p.url = `${options.url}/`
				r = await requestUrl(p)
			}

			// console.debug(`after request:`);
			const rspHeaders = objKeyToLower({ ...r.headers })
			// console.debug(`rspHeaders: ${JSON.stringify(rspHeaders, null, 2)}`);
			for (const key in rspHeaders) {
				if (rspHeaders.hasOwnProperty(key)) {
					// avoid the error:
					// Failed to read the 'headers' property from 'ResponseInit': String contains non ISO-8859-1 code point.
					// const possibleNonAscii = [
					//   "Content-Disposition",
					//   "X-Accel-Redirect",
					//   "X-Outfilename",
					//   "X-Sendfile"
					// ];
					// for (const p of possibleNonAscii) {
					//   if (key === p || key === p.toLowerCase()) {
					//     rspHeaders[key] = encodeURIComponent(rspHeaders[key]);
					//   }
					// }
					if (!onlyAscii(rspHeaders[key])) {
						// console.debug(`rspHeaders[key] needs encode: ${key}`);
						rspHeaders[key] = encodeURIComponent(rspHeaders[key])
					}
				}
			}

			let r2: Response | undefined = undefined
			const statusText = getReasonPhrase(r.status)
			// console.debug(`statusText: ${statusText}`);
			if ([101, 103, 204, 205, 304].includes(r.status)) {
				// A null body status is a status that is 101, 103, 204, 205, or 304.
				// https://fetch.spec.whatwg.org/#statuses
				// fix this: Failed to construct 'Response': Response with null body status cannot have body
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
