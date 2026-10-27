import type { RequestUrlResponse } from 'obsidian'

export class RequestUrlError extends Error {
	constructor(public res: RequestUrlResponse) {
		super(`${res.status}: ${res.text}`)
	}
}
