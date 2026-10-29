import { describe, expect, it } from 'vitest'
import type { AppUIMessage } from '~/ai/chat/types'
import type { ChatSession } from '~/ai/chat/domain'
import {
	createEmptyMasterAgent,
	selectContextTimeline,
} from '~/ai/chat/messages/ui-message'
import { migrateChatSession } from './session-migration'
import {
	decodeChatSessionFromStorage,
	encodeChatSessionForStorage,
} from './session-persistence'

const text = '中性记录 Neutral record 🌿'
function message(
	id: string,
	role: 'user' | 'assistant' = 'user',
): AppUIMessage {
	return { id, role, parts: [{ type: 'text', text }] }
}
function checkpoint(id: string, preservedTurnCount: number) {
	return {
		id,
		role: 'user' as const,
		parts: [
			{
				type: 'data-context-checkpoint' as const,
				data: { mode: 'summary' as const, summary: text, preservedTurnCount },
			},
		],
	}
}
function session(timeline: AppUIMessage[]): ChatSession {
	return {
		schemaVersion: 2,
		id: '中性-session-🌿',
		createdAt: 1,
		updatedAt: 1,
		subagents: { master: { ...createEmptyMasterAgent(1), timeline } },
	}
}
function ids(timeline: AppUIMessage[]) {
	return selectContextTimeline(timeline).map((value) => value.id)
}

describe('legacy checkpoint migration at session loading', () => {
	it('resolves nested counts before runtime selection without changing stored history', async () => {
		const original = session([
			message('请求-request-🌿'),
			message('答复-reply-🌿', 'assistant'),
			checkpoint('摘要-summary-一', 1),
			message('u2'),
			message('a2', 'assistant'),
			checkpoint('摘要-summary-二', 2),
			message('u3'),
		])
		const snapshot = JSON.stringify(original)
		const migrated = migrateChatSession(original)
		const timeline = migrated.session.subagents.master.timeline
		expect(migrated.changed).toBe(true)
		expect(ids(timeline)).toEqual([
			'摘要-summary-二',
			'请求-request-🌿',
			'答复-reply-🌿',
			'u2',
			'a2',
			'u3',
		])
		expect(timeline[5].parts[0]).toMatchObject({
			data: {
				retainedMessageIds: ['请求-request-🌿', '答复-reply-🌿', 'u2', 'a2'],
			},
		})
		expect(JSON.stringify(original)).toBe(snapshot)
		expect(JSON.stringify(migrated.session)).not.toContain('preservedTurnCount')
		expect(migrateChatSession(migrated.session)).toEqual({
			session: migrated.session,
			changed: false,
		})
		const loaded = migrateChatSession(
			decodeChatSessionFromStorage(
				await encodeChatSessionForStorage(migrated.session),
			),
		)
		expect(loaded.changed).toBe(false)
		expect(ids(loaded.session.subagents.master.timeline)).toEqual(ids(timeline))
	})

	it.each([0, 1, 10])(
		'retains the available requested turns (%s) without resurrecting reset context',
		(count) => {
			const reset: AppUIMessage = {
				id: 'reset-清空-🌿',
				role: 'user',
				parts: [{ type: 'data-context-checkpoint', data: { mode: 'reset' } }],
			}
			const migrated = migrateChatSession(
				session([
					message('old-旧-🌿'),
					reset,
					message('current-当前-🌿'),
					message('reply-答复-🌿', 'assistant'),
					checkpoint('summary-摘要-🌿', count),
				]),
			)
			expect(ids(migrated.session.subagents.master.timeline)).toEqual([
				'summary-摘要-🌿',
				'current-当前-🌿',
				'reply-答复-🌿',
			])
		},
	)

	it('migrates child histories while preserving current snapshot boundaries', () => {
		const original = session([
			message('request-请求-🌿'),
			{
				...checkpoint('summary-摘要-🌿', 3),
				parts: [
					{
						type: 'data-context-checkpoint',
						data: {
							...checkpoint('summary-摘要-🌿', 3).parts[0].data,
							summarizedThroughMessageId: 'request-请求-🌿',
							retainedMessageIds: [],
						},
					},
				],
			},
		])
		original.subagents.master.subagents.child = {
			...createEmptyMasterAgent(2),
			id: 'child',
			timeline: [message('child-请求-🌿'), checkpoint('child-摘要-🌿', 1)],
		}
		const migrated = migrateChatSession(original)
		expect(ids(migrated.session.subagents.master.timeline)).toEqual([
			'summary-摘要-🌿',
		])
		expect(
			ids(migrated.session.subagents.master.subagents.child.timeline),
		).toEqual(['child-摘要-🌿', 'child-请求-🌿'])
		expect(JSON.stringify(migrated.session)).not.toContain('preservedTurnCount')
	})

	it.each([-1, 1.5, NaN])(
		'rejects an invalid historical count instead of silently dropping context (%s)',
		(count) => {
			expect(() =>
				migrateChatSession(
					session([
						message('请求-request-🌿'),
						checkpoint('摘要-summary-🌿', count),
					]),
				),
			).toThrow('Invalid legacy checkpoint turn count')
		},
	)
})
