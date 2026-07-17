import { describe, expect, it } from 'vitest'
import { projectTimelineMessageGroups } from './display-blocks'

describe('projectTimelineMessageGroups', () => {
	it('keeps user messages that only contain user context', () => {
		const groups = projectTimelineMessageGroups([
			{
				id: 'm1',
				role: 'user',
				parts: [
					{
						type: 'data-user-context',
						data: {
							items: [
								{
									type: 'image',
									hash: 'img-1',
									blob: new Blob(['x']),
									mimeType: 'image/png',
									size: 1,
								},
							],
						},
					},
				],
			},
		])
		expect(groups).toHaveLength(1)
		expect(groups[0]?.message.id).toBe('m1')
		expect(groups[0]?.blocks).toEqual([])
	})
})
