import type { AIMessage, AIProviderConfig } from './types'

export type FetchFunction = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>

interface RequestParts {
	url: string
	method: string
	headers?: HeadersInit
	body?: BodyInit | null
}

export function getInterleavedMessageField(
	provider: AIProviderConfig,
	modelId: string,
) {
	const interleaved = provider.models[modelId]?.interleaved
	if (
		interleaved &&
		typeof interleaved === 'object' &&
		typeof interleaved.field === 'string'
	) {
		return interleaved.field.trim() || undefined
	}
	return undefined
}


async function toRequestParts(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<RequestParts> {
	if (input instanceof Request) {
		const method = init?.method || input.method
		const body =
			init?.body ??
			(method === 'GET' || method === 'HEAD'
				? undefined
				: await input.clone().arrayBuffer())
		return {
			url: input.url,
			method,
			headers: init?.headers || input.headers,
			body,
		}
	}

	return {
		url: input instanceof URL ? input.toString() : String(input),
		method: init?.method || 'GET',
		headers: init?.headers,
		body: init?.body,
	}
}

function isChatCompletionsRequest(parts: RequestParts) {
	return (
		parts.method.toUpperCase() === 'POST' &&
		/\/chat\/completions(?:\?|$)/.test(parts.url)
	)
}

async function readBodyText(body: BodyInit | null | undefined) {
	if (body == null) {
		return undefined
	}
	return new Response(body).text()
}

function injectInterleavedMessageFields(
	body: unknown,
	sourceMessages: Iterable<AIMessage>,
	field: string,
) {
	if (!body || typeof body !== 'object') {
		return body
	}

	const messages = (body as { messages?: unknown }).messages
	if (!Array.isArray(messages)) {
		return body
	}

	const sourceIt = sourceMessages[Symbol.iterator]()

	for (const message of messages) {
		if (!message || typeof message !== 'object') {
			continue
		}
		if ((message as { role?: unknown }).role !== 'assistant') {
			continue
		}

		let next = sourceIt.next()
		while (!next.done && next.value.role !== 'assistant') {
			next = sourceIt.next()
		}

		if (!next.done) {
			const source = next.value
			if (source.role === 'assistant' && source.interleaved) {
				const value = source.interleaved[field]
				if (value !== undefined) {
					;(message as Record<string, unknown>)[field] = value
				}
			}
		}
	}

	return body
}

export function createInterleavedMessageFieldFetch(
	baseFetch: FetchFunction,
	messages: Iterable<AIMessage> | undefined,
	field: string | undefined,
): FetchFunction {
	if (!field || !messages) {
		return baseFetch
	}

	return async (input, init) => {
		const parts = await toRequestParts(input, init)
		if (!isChatCompletionsRequest(parts)) {
			return baseFetch(input, init)
		}

		const bodyText = await readBodyText(parts.body)
		if (bodyText === undefined) {
			return baseFetch(input, init)
		}

		let body: unknown
		try {
			body = JSON.parse(bodyText)
		} catch {
			return baseFetch(parts.url, {
				...init,
				method: parts.method,
				headers: parts.headers,
				body: bodyText,
			})
		}

		const nextBody = injectInterleavedMessageFields(body, messages, field)
		return baseFetch(parts.url, {
			...init,
			method: parts.method,
			headers: parts.headers,
			body: JSON.stringify(nextBody),
		})
	}
}
