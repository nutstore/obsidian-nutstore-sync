import { describe, expect, it } from 'vitest'
import type { ChatDisplayBlock } from '~/ai/chat/types'
import type { ChatTimelineMessageItem } from '~/ai/chat/ui/types'
import {
	projectTurns,
	turnProcessTitle,
	type TurnProcess,
} from './turn-projection'

const text = (value = 'Neutral 示例 🌿'): ChatDisplayBlock => ({
	kind: 'content',
	parts: [{ type: 'text', text: value }],
})
const reasoning: ChatDisplayBlock = {
	kind: 'reasoning',
	part: { type: 'reasoning', text: 'Compare 比较 🌿' },
}
const tool = (toolName: string, input: unknown = {}): ChatDisplayBlock => ({
	kind: 'tool-call',
	toolCall: {
		type: 'dynamic-tool',
		toolCallId: 'call',
		toolName,
		input,
		state: 'input-available',
	},
})
const item = (
	id: string,
	role: ChatTimelineMessageItem['message']['role'],
	displayBlocks: ChatDisplayBlock[] = [text()],
): ChatTimelineMessageItem => ({
	createdAt: 0,
	message: { id, role, parts: [] },
	displayBlocks,
	showHeader: true,
})
const group = (blocks: ChatDisplayBlock[], active = true): TurnProcess => ({
	kind: 'process',
	key: 'turn',
	active,
	messages: [
		{
			kind: 'message',
			key: 'message',
			item: item('assistant', 'assistant', blocks),
			blocks,
		},
	],
})
const labels = {
	thinking: '处理中 Processing 🌿',
	completed: '执行过程 Execution process 🌿',
}

describe('turn projection', () => {
	it('starts a new turn for a context-only user submission', () => {
		const rows = projectTurns(
			[
				item('u1', 'user'),
				item('a1', 'assistant', [reasoning]),
				item('context 示例 🌿', 'user', []),
				item('a2', 'assistant', [reasoning]),
			],
			'session',
			'thinking',
		)
		expect(
			rows.map((row) =>
				row.kind === 'message'
					? row.item.message.id
					: {
							messages: row.messages.map((message) => message.item.message.id),
							active: row.active,
						},
			),
		).toEqual([
			'u1',
			{ messages: ['a1'], active: false },
			'context 示例 🌿',
			{ messages: ['a2'], active: true },
		])
	})
	it('keeps plain replies and pre-user content outside groups', () => {
		const input = [
			item('prefix', 'assistant'),
			item('user', 'user'),
			item('reply', 'assistant'),
		]
		expect(
			projectTurns(input, 'session', 'idle').map((row) => row.kind),
		).toEqual(['message', 'message', 'message'])
	})
	it('moves streaming text exactly once when tools or a later assistant arrive', () => {
		const user = item('user', 'user')
		const reply = item('reply', 'assistant', [reasoning, text()])
		const input = [user, reply]
		const before = structuredClone(input)
		const rows = projectTurns(input, 'session', 'thinking')
		expect(rows.map((row) => row.kind)).toEqual([
			'message',
			'process',
			'message',
		])
		expect(rows[2]).toMatchObject({
			item: reply,
			blocks: [reply.displayBlocks[1]],
		})
		const updated = projectTurns(
			[
				user,
				{ ...reply, displayBlocks: [...reply.displayBlocks, tool('read')] },
			],
			'session',
			'thinking',
		)
		expect(updated.map((row) => row.kind)).toEqual(['message', 'process'])
		expect(updated[1]?.key).toBe(rows[1]?.key)
		const later = projectTurns(
			[...input, item('final', 'assistant')],
			'session',
			'idle',
		)
		const process = later[1] as TurnProcess
		expect(process.messages[0]?.blocks).toBe(reply.displayBlocks)
		expect(process.messages[0]?.item).toBe(reply)
		expect(process.active).toBe(false)
		expect(input).toEqual(before)
	})
	it('keeps notifications independent and activates only the current turn', () => {
		const input = [
			item('u1', 'user'),
			item('a1', 'assistant', [tool('read')]),
			item('notice', 'user', [
				{
					kind: 'system-notification',
					notification: {
						kind: 'task-result-ready',
						taskId: 'neutral-task',
						resultPath: 'notes/示例 🌿.md',
					},
				},
			]),
			item('u2', 'user'),
			item('a2', 'assistant', [reasoning, text()]),
		]
		const rows = projectTurns(input, 'session', 'waiting_for_tools')
		expect(rows.map((row) => row.kind)).toEqual([
			'message',
			'process',
			'message',
			'message',
			'process',
			'message',
		])
		expect(
			rows.filter((row) => row.kind === 'process').map((row) => row.active),
		).toEqual([false, true])
		const ended = projectTurns(input, 'session', 'idle')
		expect(
			ended.filter((row) => row.kind === 'process').map((row) => row.active),
		).toEqual([false, false])
	})
})

describe('process titles', () => {
	it('replaces the last tool title when execution ends', () => {
		const timeline = [
			item('user', 'user'),
			item('assistant', 'assistant', [
				tool('read', { purpose: 'Read 示例 🌿' }),
			]),
		]
		for (const state of ['waiting_for_tools', 'idle'] as const) {
			const process = projectTurns(timeline, 'session', state).find(
				(row): row is TurnProcess => row.kind === 'process',
			)!
			expect(turnProcessTitle(process, labels)).toBe(
				state === 'idle' ? labels.completed : 'Read 示例 🌿',
			)
		}
	})
	it.each([undefined, null, '', '  ', 1, false, [], {}])(
		'falls back for invalid purpose %j',
		(purpose) => {
			expect(
				turnProcessTitle(
					group([tool('mcp_catalog_search', { purpose })]),
					labels,
				),
			).toBe('mcp_catalog_search')
		},
	)
	it('preserves order and duplicates including Chinese, English and Emoji', () => {
		expect(
			turnProcessTitle(
				group([
					tool('read', { purpose: ' 查看 🌿 ' }),
					tool('mcp_search', { purpose: 'Search notes' }),
					tool('read', { purpose: '查看 🌿' }),
				]),
				labels,
			),
		).toBe('查看 🌿, Search notes, 查看 🌿')
	})
	it('uses placeholders and never searches previous assistant messages', () => {
		expect(turnProcessTitle(group([tool('')]), labels)).toBe(labels.thinking)
		const process = group([tool('read')], true)
		process.messages.push(...group([reasoning]).messages)
		expect(turnProcessTitle(process, labels)).toBe(labels.thinking)
		process.active = false
		expect(turnProcessTitle(process, labels)).toBe(labels.completed)
	})
})
