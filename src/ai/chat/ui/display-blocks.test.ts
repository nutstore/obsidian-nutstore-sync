import { describe, expect, it } from 'vitest'
import { BASH_TMP_MOUNT_POINT } from '~/ai/tools/bash/mount-points'
import { projectTimelineMessageGroups } from './display-blocks'

describe('projectTimelineMessageGroups', () => {
	it('projects English and Chinese reasoning as separate display blocks', () => {
		const groups = projectTimelineMessageGroups([
			{
				id: 'message',
				role: 'assistant',
				parts: [
					{ type: 'text', text: 'First response.' },
					{ type: 'reasoning', text: 'Check the next step.' },
					{ type: 'text', text: '后续内容。' },
					{ type: 'reasoning', text: '确认下一步。' },
				],
			},
		])

		expect(groups[0]?.blocks).toEqual([
			{ kind: 'content', parts: [{ type: 'text', text: 'First response.' }] },
			{
				kind: 'reasoning',
				part: { type: 'reasoning', text: 'Check the next step.' },
			},
			{ kind: 'content', parts: [{ type: 'text', text: '后续内容。' }] },
			{
				kind: 'reasoning',
				part: { type: 'reasoning', text: '确认下一步。' },
			},
		])
	})

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
							resultPath: `${BASH_TMP_MOUNT_POINT}/session/tasks/explorer-one.txt`,
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
					resultPath: `${BASH_TMP_MOUNT_POINT}/session/tasks/explorer-one.txt`,
				},
			},
		])
	})
})
