import { describe, expect, it } from 'vitest'
import { decideDropRoute } from './drop-utils'

function makeDragEvent(options: {
	types?: string[]
	data?: Record<string, string>
	files?: File[]
}): DragEvent {
	const types = options.types ?? []
	const data = options.data ?? {}
	const files = options.files ?? []
	const dataTransfer = {
		types,
		getData: (type: string) => data[type] ?? '',
		files,
	}
	return {
		dataTransfer,
	} as unknown as DragEvent
}

describe('decideDropRoute', () => {
	it('routes to paths when obsidian path payload is present', () => {
		const event = makeDragEvent({
			types: ['text/plain'],
			data: { 'text/plain': 'notes/foo.md' },
		})
		const route = decideDropRoute(event)
		expect(route.paths).toEqual(['notes/foo.md'])
		expect(route.files).toEqual([])
	})

	it('routes to paths even when files are also present (vault drag carries both)', () => {
		const file = new File(['x'], 'foo.md', { type: 'text/markdown' })
		const event = makeDragEvent({
			types: ['text/plain', 'Files'],
			data: { 'text/plain': 'notes/foo.md' },
			files: [file],
		})
		const route = decideDropRoute(event)
		expect(route.paths).toEqual(['notes/foo.md'])
		expect(route.files).toEqual([])
	})

	it('falls back to external files when no path payload is present', () => {
		const file = new File(['x'], 'external.png', { type: 'image/png' })
		const event = makeDragEvent({
			types: ['Files'],
			files: [file],
		})
		const route = decideDropRoute(event)
		expect(route.paths).toEqual([])
		expect(route.files).toEqual([file])
	})

	it('returns empty route when dataTransfer has neither paths nor files', () => {
		const event = makeDragEvent({ types: [] })
		const route = decideDropRoute(event)
		expect(route.paths).toEqual([])
		expect(route.files).toEqual([])
	})

	it('ignores Files-type string payloads when extracting paths', () => {
		const event = makeDragEvent({
			types: ['Files'],
			data: { Files: 'should-be-ignored' },
		})
		const route = decideDropRoute(event)
		expect(route.paths).toEqual([])
	})
})
