import { describe, expect, it } from 'vitest'
import { projectFragmentMessageGroups } from './display-blocks'

describe('projectFragmentMessageGroups', () => {
	it('keeps user messages that only contain user context', () => {
		const groups = projectFragmentMessageGroups([
			{
				id: 'm1',
				createdAt: 1,
				message: {
					role: 'user',
					content: [],
				},
				userContext: [
					{
						type: 'image',
						hash: 'img-1',
						blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
						mimeType: 'image/png',
						name: 'demo.png',
						size: 1,
					},
				],
			},
		])

		expect(groups).toHaveLength(1)
		expect(groups[0]?.record.id).toBe('m1')
		expect(groups[0]?.blocks).toEqual([])
	})

	it('suppresses legacy image file parts when mirrored in user context', () => {
		const groups = projectFragmentMessageGroups([
			{
				id: 'm2',
				createdAt: 2,
				message: {
					role: 'user',
					content: [
						{
							type: 'file',
							mediaType: 'image/png',
							data: 'data:image/png;base64,AA==',
						},
					],
				},
				userContext: [
					{
						type: 'image',
						hash: 'img-2',
						blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
						mimeType: 'image/png',
						name: 'demo.png',
						size: 1,
					},
				],
			},
		])

		expect(groups).toHaveLength(1)
		expect(groups[0]?.blocks).toEqual([])
	})
})
