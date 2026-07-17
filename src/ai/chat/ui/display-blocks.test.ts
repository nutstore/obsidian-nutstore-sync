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

	it('projects system notification data parts as visible timeline blocks', () => {
		const groups = projectTimelineMessageGroups([
			{
				id: 'notification',
				role: 'user',
				parts: [
					{
						type: 'data-system-notification',
						data: {
							kind: 'task-result-ready',
							taskId: 'explorer-one',
							resultPath: '/tmp/session/tasks/explorer-one.txt',
						},
					},
				],
			},
		])

		expect(groups).toHaveLength(1)
		expect(groups[0]?.blocks).toEqual([
			{
				kind: 'system-notification',
				notification: {
					kind: 'task-result-ready',
					taskId: 'explorer-one',
					resultPath: '/tmp/session/tasks/explorer-one.txt',
				},
			},
		])
	})
})
