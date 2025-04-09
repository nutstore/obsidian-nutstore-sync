import {
	requestUrl as req,
	RequestUrlParam,
	RequestUrlResponse,
} from 'obsidian'
import logger from './logger'

class RequestUrlError extends Error {
	constructor(public res: RequestUrlResponse) {
		super(`${res.status}: ${res.text}`)
	}
}

export default async function requestUrl(p: RequestUrlParam | string) {
	let res: RequestUrlResponse
	let throwError = true
	if (typeof p === 'string') {
		res = await req({
			url: p,
			throw: false,
		})
	} else if (p.throw !== false) {
		res = await req({
			...p,
			throw: false,
		})
	} else {
		res = await req(p)
		throwError = false
	}
	if (res.status >= 400) {
		logger.error(res)
		if (throwError) {
			throw new RequestUrlError(res)
		}
	}
	return res
}
