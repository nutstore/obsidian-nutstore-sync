import { getReasonPhrase } from 'http-status-codes'
import type { FetchFunction } from '~/ai/interleaved-message-field'
import requestUrl from '~/utils/request-url'

function toHeadersRecord(headers?: HeadersInit) {
	if (!headers) {
		return undefined
	}

	if (headers instanceof Headers) {
		const entries: Array<[string, string]> = []
		headers.forEach((value, key) => {
			entries.push([key, value])
		})
		return Object.fromEntries(entries)
	}
	if (Array.isArray(headers)) {
		return Object.fromEntries(headers)
	}
	return { ...headers }
}

async function toRequestParts(input: RequestInfo | URL, init?: RequestInit) {
	if (input instanceof Request) {
		return {
			url: input.url,
			method: init?.method || input.method,
			headers: toHeadersRecord(init?.headers || input.headers),
			body: init?.body
				? await new Response(init.body).arrayBuffer()
				: input.method === 'GET' || input.method === 'HEAD'
					? undefined
					: await input.arrayBuffer(),
		}
	}

	return {
		url: input instanceof URL ? input.toString() : String(input),
		method: init?.method || 'GET',
		headers: toHeadersRecord(init?.headers),
		body: init?.body ? await new Response(init.body).arrayBuffer() : undefined,
	}
}

export const obsidianFetch: FetchFunction = async (
	input: RequestInfo | URL,
	init?: RequestInit,
) => {
	const request = await toRequestParts(input, init)
	const response = await requestUrl({
		url: request.url,
		method: request.method,
		headers: request.headers,
		body: request.body,
		throw: false,
	})
	const statusText = getReasonPhrase(response.status)

	return new Response(
		[101, 103, 204, 205, 304].includes(response.status)
			? null
			: response.arrayBuffer,
		{
			status: response.status,
			statusText,
			headers: response.headers,
		},
	)
}
