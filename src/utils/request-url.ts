import {
	requestUrl as req,
	RequestUrlParam,
	RequestUrlResponse,
} from 'obsidian'
import logger from './logger'
import { isNutstoreHost, MOCK_USER_AGENT, NS_SYNC_USER_AGENT } from './ua'

class RequestUrlError extends Error {
	constructor(public res: RequestUrlResponse) {
		super(`${res.status}: ${res.text}`)
	}
}

export default async function requestUrl(p: RequestUrlParam | string) {
	const url = typeof p === 'string' ? p : p.url
	const originalHeaders = typeof p === 'string' ? {} : p.headers || {}
	const headers = isNutstoreHost(url)
		? {
				...originalHeaders,
				'User-Agent': NS_SYNC_USER_AGENT,
			}
		: {
				...originalHeaders,
				'User-Agent': MOCK_USER_AGENT,
			}

	const params: RequestUrlParam =
		typeof p === 'string'
			? {
					url,
					throw: false,
					headers,
				}
			: {
					...p,
					throw: false,
					headers,
				}

	const res = await req(params)

	if (res.status >= 400) {
		logger.error(res)
		if (typeof p === 'string' || p.throw !== false) {
			throw new RequestUrlError(res)
		}
	}

	return res
}
