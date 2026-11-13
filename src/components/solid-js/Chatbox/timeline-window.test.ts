import { describe, expect, it } from 'vitest'
import type { ChatDisplayBlock } from '~/ai/chat/types'
import type { ChatTimelineMessageItem } from '~/ai/chat/ui/types'
import { sliceTimelineByTurns } from './timeline-window'

function item(
	id: string,
	role: ChatTimelineMessageItem['message']['role'],
	blocks: ChatDisplayBlock[] = [
		{ kind: 'content', parts: [{ type: 'text', text: 'neutral 🌿' }] },
	],
): ChatTimelineMessageItem {
	return {
		message: { id, role, parts: [] },
		displayBlocks: blocks,
		createdAt: 0,
		showHeader: true,
	}
}

const notification = (id: string): ChatTimelineMessageItem =>
	item(id, 'user', [
		{
			kind: 'system-notification',
			notification: {
				kind: 'task-result-ready',
				taskId: 'task',
				resultPath: 'notes/neutral.md',
				createdAt: 0,
			},
		},
	])

describe('sliceTimelineByTurns', () => {
	it('keeps the requested number of newest turns', () => {
		const timeline = [
			item('user-1', 'user'),
			item('reply-1', 'assistant'),
			item('user-2', 'user'),
			item('reply-2', 'assistant'),
			item('user-3', 'user'),
			item('reply-3', 'assistant'),
		]

		expect(
			sliceTimelineByTurns(timeline, 2).map(({ message }) => message.id),
		).toEqual(['user-2', 'reply-2', 'user-3', 'reply-3'])
	})

	it('does not count notification-only user messages as turns', () => {
		const timeline = [
			item('user-1', 'user'),
			item('reply-1', 'assistant'),
			notification('task-result'),
			item('user-2', 'user'),
			item('reply-2', 'assistant'),
		]

		expect(
			sliceTimelineByTurns(timeline, 1).map(({ message }) => message.id),
		).toEqual(['user-2', 'reply-2'])
	})

	it('returns the full timeline without a limit', () => {
		const timeline = [item('user-1', 'user'), item('reply-1', 'assistant')]

		expect(sliceTimelineByTurns(timeline, 0)).toBe(timeline)
	})
})
