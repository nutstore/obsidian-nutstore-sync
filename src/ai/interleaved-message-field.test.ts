import { describe, expect, it, vi } from 'vitest'
import {
	createInterleavedMessageFieldFetch,
} from './interleaved-message-field'
import type { AIMessage } from './types'

describe('interleaved message field transport', () => {
	it('injects the configured field into matching assistant ordinals from source messages', async () => {
		const baseFetch = vi.fn(async () => new Response('{}'))
		const sourceMessages: AIMessage[] = [
			{ role: 'system', content: [{ type: 'text', text: 'system' }] },
			{ role: 'assistant', content: [{ type: 'text', text: 'first' }] },
			{ role: 'user', content: [{ type: 'text', text: 'tool result' }] },
			{
				role: 'assistant',
				content: [{ type: 'text', text: 'second' }],
				interleaved: { vendor_context: 'context snapshot' },
			},
		]
		const fetch = createInterleavedMessageFieldFetch(
			baseFetch,
			sourceMessages,
			'vendor_context',
		)

		await fetch('https://example.com/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({
				messages: [
					{ role: 'system', content: 'system' },
					{ role: 'assistant', content: 'first' },
					{ role: 'user', content: 'tool result' },
					{ role: 'assistant', content: 'second' },
				],
			}),
		})

		const calls = baseFetch.mock.calls as unknown as Array<
			[RequestInfo | URL, RequestInit?]
		>
		const body = JSON.parse(calls[0][1]?.body as string)
		expect(body.messages[1].vendor_context).toBeUndefined()
		expect(body.messages[3].vendor_context).toBe('context snapshot')
	})

	it('injects empty string field values', async () => {
		const baseFetch = vi.fn(async () => new Response('{}'))
		const fetch = createInterleavedMessageFieldFetch(
			baseFetch,
			[
				{
					role: 'assistant',
					content: [{ type: 'text', text: '' }],
					interleaved: { vendor_context: '' },
				},
			],
			'vendor_context',
		)

		await fetch('https://example.com/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({
				messages: [{ role: 'assistant', content: '' }],
			}),
		})

		const calls = baseFetch.mock.calls as unknown as Array<
			[RequestInfo | URL, RequestInit?]
		>
		const body = JSON.parse(calls[0][1]?.body as string)
		expect(body.messages[0]).toHaveProperty('vendor_context', '')
	})

	it('passes body through unmodified when no source message carries the configured field', async () => {
		const baseFetch = vi.fn(async () => new Response('{}'))
		const fetch = createInterleavedMessageFieldFetch(
			baseFetch,
			[{ role: 'assistant', content: [{ type: 'text', text: 'first' }] }],
			'vendor_context',
		)

		await fetch('https://example.com/v1/chat/completions', {
			method: 'POST',
			body: JSON.stringify({
				messages: [{ role: 'assistant', content: 'first' }],
			}),
		})

		const calls = baseFetch.mock.calls as unknown as Array<
			[RequestInfo | URL, RequestInit?]
		>
		const body = JSON.parse(calls[0][1]?.body as string)
		expect(body.messages[0]).not.toHaveProperty('vendor_context')
	})

	it('returns the base fetch when no field is configured', async () => {
		const baseFetch = vi.fn(async () => new Response('{}'))
		const fetch = createInterleavedMessageFieldFetch(
			baseFetch,
			[
				{
					role: 'assistant',
					content: [{ type: 'text', text: 'first' }],
					interleaved: { vendor_context: 'snapshot' },
				},
			],
			undefined,
		)

		expect(fetch).toBe(baseFetch)
	})

	it('does not rewrite non-chat-completions requests', async () => {
		const baseFetch = vi.fn(async () => new Response('{}'))
		const fetch = createInterleavedMessageFieldFetch(
			baseFetch,
			[
				{
					role: 'assistant',
					content: [{ type: 'text', text: '' }],
					interleaved: { vendor_context: 'context snapshot' },
				},
			],
			'vendor_context',
		)
		const init = {
			method: 'POST',
			body: JSON.stringify({
				messages: [{ role: 'assistant', content: '' }],
			}),
		}

		await fetch('https://example.com/v1/embeddings', init)

		expect(baseFetch).toHaveBeenCalledWith(
			'https://example.com/v1/embeddings',
			init,
		)
	})

	it('passes through non-JSON chat-completions bodies', async () => {
		const baseFetch = vi.fn(async () => new Response('{}'))
		const fetch = createInterleavedMessageFieldFetch(
			baseFetch,
			[
				{
					role: 'assistant',
					content: [{ type: 'text', text: '' }],
					interleaved: { vendor_context: 'context snapshot' },
				},
			],
			'vendor_context',
		)

		await fetch('https://example.com/v1/chat/completions', {
			method: 'POST',
			body: 'not-json',
		})

		const calls = baseFetch.mock.calls as unknown as Array<
			[RequestInfo | URL, RequestInit?]
		>
		expect(calls[0][1]?.body).toBe('not-json')
	})
})


