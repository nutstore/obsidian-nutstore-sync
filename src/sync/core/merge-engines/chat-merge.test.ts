import { describe, expect, it } from 'vitest'
import type { ChatSession } from '~/ai/chat/domain'
import type {
	ChatMetaFile,
	ChatSessionFilePayload,
} from '~/ai/chat/session/session-files'
import type { PersistedChatSession } from '~/ai/chat/session/session-persistence'
import type { AppUIMessage, ChatAgentState } from '~/ai/chat/types'
import {
	chatMetaMergeEngine,
	chatSessionMergeEngine,
	isChatMetaPath,
	isChatSessionPath,
} from './chat-merge'
import { diff3MergeEngine } from './diff3-merge'
import { jsonMergeEngine } from './json-merge'
import {
	DIFF3_MERGE_ENGINES,
	NO_CONFLICT_MERGE_ENGINES,
	matchMergeEngine,
	resolveWithMergeRouter,
} from './router'
import { resolveByDiff3Merge, resolveByIntelligentMerge } from '../merge-utils'
import { yjsTextMergeEngine } from './yjs-text-merge'

function makeMessage(
	id: string,
	role: 'user' | 'assistant',
	text: string,
	createdAt: number,
): AppUIMessage {
	return {
		id,
		role,
		parts: [{ type: 'text', text }],
		metadata: { createdAt },
	}
}

function makeAgent(
	id = 'master',
	overrides: Partial<ChatAgentState> = {},
): ChatAgentState {
	return {
		id,
		type: id === 'master' ? 'master' : 'subagent',
		status: 'idle',
		createdAt: 100,
		timeline: [],
		pendingInputs: [],
		operations: {},
		toolTimings: {},
		subagents: {},
		...overrides,
	}
}

function makeSessionPayload(
	overrides: Partial<ChatSession> = {},
	title?: string,
): ChatSessionFilePayload {
	const session: ChatSession = {
		schemaVersion: 2,
		id: 'session-1',
		createdAt: 100,
		updatedAt: 100,
		subagents: {
			master: makeAgent('master'),
		},
		...overrides,
	}
	const persisted = session as unknown as PersistedChatSession
	return title === undefined
		? { session: persisted }
		: { session: persisted, title }
}

function compact(value: unknown): string {
	return `${JSON.stringify(value)}\n`
}

function pretty(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`
}

describe('merge router & pure path matchers', () => {
	it('matches chat session paths across separators and casing', () => {
		expect(isChatSessionPath('.agents/nutstore-sync/sessions/s1.json')).toBe(
			true,
		)
		expect(isChatSessionPath('/.agents/nutstore-sync/sessions/S-1.JSON')).toBe(
			true,
		)
		expect(
			isChatSessionPath('  .agents\\nutstore-sync\\sessions\\abc_123.json  '),
		).toBe(true)

		expect(
			isChatSessionPath('.agents/nutstore-sync/sessions/nested/s1.json'),
		).toBe(false)
		expect(isChatSessionPath('.agents/nutstore-sync/sessions/.json')).toBe(
			false,
		)
		expect(isChatSessionPath('.agents/nutstore-sync/chat-meta.json')).toBe(
			false,
		)
		expect(isChatSessionPath('settings/example.json')).toBe(false)
	})

	it('matches chat meta path across separators and casing', () => {
		expect(isChatMetaPath('.agents/nutstore-sync/chat-meta.json')).toBe(true)
		expect(isChatMetaPath('/.agents\\nutstore-sync\\CHAT-META.JSON')).toBe(true)
		expect(isChatMetaPath('.agents/nutstore-sync/sessions/meta.json')).toBe(
			false,
		)
	})

	it('routes paths by priority across Diff3 and NoConflictMerge pipelines', () => {
		expect(
			matchMergeEngine(
				'.agents/nutstore-sync/sessions/abc.json',
				NO_CONFLICT_MERGE_ENGINES,
			)?.id,
		).toBe(chatSessionMergeEngine.id)
		expect(
			matchMergeEngine(
				'.agents/nutstore-sync/chat-meta.json',
				NO_CONFLICT_MERGE_ENGINES,
			)?.id,
		).toBe(chatMetaMergeEngine.id)
		expect(
			matchMergeEngine('settings/example.json', NO_CONFLICT_MERGE_ENGINES)?.id,
		).toBe(jsonMergeEngine.id)
		expect(
			matchMergeEngine('notes/daily.md', NO_CONFLICT_MERGE_ENGINES)?.id,
		).toBe(yjsTextMergeEngine.id)
		expect(matchMergeEngine(undefined, NO_CONFLICT_MERGE_ENGINES)?.id).toBe(
			yjsTextMergeEngine.id,
		)

		expect(
			matchMergeEngine(
				'.agents/nutstore-sync/sessions/abc.json',
				DIFF3_MERGE_ENGINES,
			)?.id,
		).toBe(chatSessionMergeEngine.id)
		expect(
			matchMergeEngine(
				'.agents/nutstore-sync/chat-meta.json',
				DIFF3_MERGE_ENGINES,
			)?.id,
		).toBe(chatMetaMergeEngine.id)
		expect(
			matchMergeEngine('settings/example.json', DIFF3_MERGE_ENGINES)?.id,
		).toBe(diff3MergeEngine.id)
		expect(matchMergeEngine('notes/daily.md', DIFF3_MERGE_ENGINES)?.id).toBe(
			diff3MergeEngine.id,
		)
		expect(matchMergeEngine(undefined, DIFF3_MERGE_ENGINES)?.id).toBe(
			diff3MergeEngine.id,
		)

		const customResult = resolveWithMergeRouter(
			{
				filePath: 'custom/special.txt',
				baseContentText: 'a',
				localContentText: 'b',
				remoteContentText: 'c',
			},
			[
				{
					id: 'custom-first',
					match: (path) => path.endsWith('.txt'),
					merge: () => ({ success: true, mergedText: 'first-matched' }),
				},
				{
					id: 'custom-second',
					match: () => true,
					merge: () => ({ success: true, mergedText: 'second-matched' }),
				},
			],
		)
		expect(customResult).toEqual({
			success: true,
			mergedText: 'first-matched',
		})

		const unmatched = resolveWithMergeRouter(
			{
				filePath: 'notes/daily.md',
				baseContentText: 'a',
				localContentText: 'b',
				remoteContentText: 'c',
			},
			[],
		)
		expect(unmatched.success).toBe(false)
	})
})

describe('chat session merge engine', () => {
	const sessionPath = '.agents/nutstore-sync/sessions/session-1.json'

	it('merges compact single-line JSON under Diff3 without conflict markers', () => {
		const m1 = makeMessage('u1', 'user', 'Hello', 100)
		const m2 = makeMessage('a1', 'assistant', 'Hi!', 110)
		const localMsg = makeMessage('u2', 'user', 'Local question', 200)
		const remoteMsg = makeMessage('u3', 'user', 'Remote question', 300)

		const base = makeSessionPayload(
			{
				updatedAt: 110,
				subagents: { master: makeAgent('master', { timeline: [m1, m2] }) },
			},
			'Original Title',
		)
		const local = makeSessionPayload(
			{
				updatedAt: 200,
				subagents: {
					master: makeAgent('master', { timeline: [m1, m2, localMsg] }),
				},
			},
			'Renamed Locally',
		)
		const remote = makeSessionPayload(
			{
				updatedAt: 300,
				subagents: {
					master: makeAgent('master', { timeline: [m1, m2, remoteMsg] }),
				},
			},
			'Original Title',
		)

		const result = resolveByDiff3Merge({
			filePath: sessionPath,
			hasBase: true,
			baseContentText: compact(base),
			localContentText: compact(local),
			remoteContentText: compact(remote),
		})

		expect(result.success).toBe(true)
		expect(result.mergedText).not.toContain('<<<<<<<')
		expect(result.mergedText!.trimEnd().includes('\n')).toBe(false)

		const parsed = JSON.parse(result.mergedText!) as ChatSessionFilePayload
		expect(parsed.title).toBe('Renamed Locally')
		expect(parsed.session.updatedAt).toBe(300)
		expect(
			(parsed.session as ChatSession).subagents.master.timeline.map(
				(m) => m.id,
			),
		).toEqual(['u1', 'a1', 'u2', 'u3'])
	})

	it('also routes NoConflictMerge so concurrent timeline appends are not dropped', async () => {
		const m1 = makeMessage('u1', 'user', 'Base', 100)
		const localTurn = [
			makeMessage('u2', 'user', 'Local prompt', 200),
			makeMessage('a2', 'assistant', 'Local reply', 250),
		]
		const remoteTurn = [
			makeMessage('u3', 'user', 'Remote prompt', 210),
			makeMessage('a3', 'assistant', 'Remote reply', 220),
		]

		const base = makeSessionPayload({
			updatedAt: 100,
			subagents: { master: makeAgent('master', { timeline: [m1] }) },
		})
		const local = makeSessionPayload({
			updatedAt: 250,
			subagents: {
				master: makeAgent('master', { timeline: [m1, ...localTurn] }),
			},
		})
		const remote = makeSessionPayload({
			updatedAt: 220,
			subagents: {
				master: makeAgent('master', { timeline: [m1, ...remoteTurn] }),
			},
		})

		const result = await resolveByIntelligentMerge({
			filePath: sessionPath,
			hasBase: true,
			baseContentText: compact(base),
			localContentText: compact(local),
			remoteContentText: compact(remote),
		})

		expect(result.success).toBe(true)
		const parsed = JSON.parse(result.mergedText!) as ChatSessionFilePayload
		// Turn groups stay intact (u2->a2 not interleaved with u3->a3).
		expect(
			(parsed.session as ChatSession).subagents.master.timeline.map(
				(m) => m.id,
			),
		).toEqual(['u1', 'u2', 'a2', 'u3', 'a3'])
	})

	it('respects deletions/recalls and prunes deleted message operations', () => {
		const m1 = makeMessage('u1', 'user', 'Keep', 100)
		const m2 = makeMessage('a1', 'assistant', 'Delete me', 110)
		const m3 = makeMessage('u2', 'user', 'New remote', 200)

		const opKeep = {
			vaultPath: 'a.md',
			operation: 'create' as const,
			before: { kind: 'file' as const },
		}
		const opDelete = {
			vaultPath: 'b.md',
			operation: 'create' as const,
			before: { kind: 'file' as const },
		}
		const opNew = {
			vaultPath: 'c.md',
			operation: 'create' as const,
			before: { kind: 'file' as const },
		}

		const base = makeSessionPayload({
			updatedAt: 110,
			subagents: {
				master: makeAgent('master', {
					timeline: [m1, m2],
					operations: { u1: [opKeep], a1: [opDelete] },
					toolTimings: { t1: { startedAt: 100, finishedAt: 105 } },
					readVaultPaths: ['a.md', 'b.md'],
				}),
			},
		})
		const local = makeSessionPayload({
			updatedAt: 150,
			subagents: {
				master: makeAgent('master', {
					timeline: [m1],
					operations: { u1: [opKeep] },
					toolTimings: { t1: { startedAt: 100, finishedAt: 105 } },
					readVaultPaths: ['a.md'],
				}),
			},
		})
		const remote = makeSessionPayload({
			updatedAt: 200,
			subagents: {
				master: makeAgent('master', {
					timeline: [m1, m2, m3],
					operations: { u1: [opKeep], a1: [opDelete], u2: [opNew] },
					toolTimings: {
						t1: { startedAt: 100, finishedAt: 105 },
						t2: { startedAt: 190, finishedAt: 195 },
					},
					readVaultPaths: ['a.md', 'b.md', 'c.md'],
				}),
			},
		})

		const result = resolveByDiff3Merge({
			filePath: sessionPath,
			hasBase: true,
			baseContentText: compact(base),
			localContentText: compact(local),
			remoteContentText: compact(remote),
		})

		expect(result.success).toBe(true)
		const master = (
			JSON.parse(result.mergedText!) as ChatSessionFilePayload & {
				session: ChatSession
			}
		).session.subagents.master
		expect(master.timeline.map((m) => m.id)).toEqual(['u1', 'u2'])
		expect(Object.keys(master.operations)).toEqual(['u1', 'u2'])
		expect(Object.keys(master.toolTimings)).toEqual(['t1', 't2'])
		expect(master.readVaultPaths).toEqual(['a.md', 'c.md'])
	})

	it('merges without base by anchoring on shared messages', () => {
		const m1 = makeMessage('u1', 'user', 'Shared', 100)
		const localMsg = makeMessage('u2', 'user', 'Local', 300)
		const remoteMsg = makeMessage('u3', 'user', 'Remote', 200)

		const local = makeSessionPayload({
			updatedAt: 300,
			subagents: {
				master: makeAgent('master', { timeline: [m1, localMsg] }),
			},
		})
		const remote = makeSessionPayload({
			updatedAt: 200,
			subagents: {
				master: makeAgent('master', { timeline: [m1, remoteMsg] }),
			},
		})

		const result = resolveByDiff3Merge({
			filePath: sessionPath,
			hasBase: false,
			baseContentText: '',
			localContentText: compact(local),
			remoteContentText: compact(remote),
		})

		expect(result.success).toBe(true)
		const master = (
			JSON.parse(result.mergedText!) as ChatSessionFilePayload & {
				session: ChatSession
			}
		).session.subagents.master
		expect(master.timeline.map((m) => m.id)).toEqual(['u1', 'u3', 'u2'])
	})

	it('merges subagent trees recursively and handles __proto__ keys safely', () => {
		const baseSub = makeAgent('sub-1', {
			status: 'running',
			timeline: [makeMessage('s1', 'user', 'Task', 100)],
		})
		const localSub = makeAgent('sub-1', {
			status: 'completed',
			finishedAt: 200,
			timeline: [
				makeMessage('s1', 'user', 'Task', 100),
				makeMessage('s2', 'assistant', 'Done', 200),
			],
			operations: Object.fromEntries([['__proto__', []]]),
		})
		const remoteSub = makeAgent('sub-1', {
			status: 'running',
			timeline: [makeMessage('s1', 'user', 'Task', 100)],
		})
		const remoteOnlySub = makeAgent('sub-2', {
			status: 'completed',
			finishedAt: 250,
			timeline: [makeMessage('s3', 'user', 'Second task', 220)],
		})

		const base = makeSessionPayload({
			updatedAt: 100,
			subagents: {
				master: makeAgent('master', { subagents: { 'sub-1': baseSub } }),
			},
		})
		const local = makeSessionPayload({
			updatedAt: 200,
			subagents: {
				master: makeAgent('master', { subagents: { 'sub-1': localSub } }),
			},
		})
		const remote = makeSessionPayload({
			updatedAt: 250,
			subagents: {
				master: makeAgent('master', {
					subagents: { 'sub-1': remoteSub, 'sub-2': remoteOnlySub },
				}),
			},
		})

		const result = resolveByDiff3Merge({
			filePath: sessionPath,
			hasBase: true,
			baseContentText: compact(base),
			localContentText: compact(local),
			remoteContentText: compact(remote),
		})

		expect(result.success).toBe(true)
		const parsed = JSON.parse(result.mergedText!) as ChatSessionFilePayload & {
			session: ChatSession
		}
		const master = parsed.session.subagents.master
		expect(Object.keys(master.subagents)).toEqual(['sub-1', 'sub-2'])
		expect(master.subagents['sub-1'].status).toBe('completed')
		expect(master.subagents['sub-1'].timeline.map((m) => m.id)).toEqual([
			's1',
			's2',
		])
		expect(
			Object.hasOwn(master.subagents['sub-1'].operations, '__proto__'),
		).toBe(true)
	})

	it('recovers when one side is corrupted and fails cleanly when both are corrupted', () => {
		const valid = compact(makeSessionPayload({ updatedAt: 200 }, 'Valid'))

		const localValid = resolveByDiff3Merge({
			filePath: sessionPath,
			hasBase: false,
			baseContentText: '',
			localContentText: valid,
			remoteContentText: '<<<<<<< corrupt',
		})
		expect(localValid).toEqual({ success: true, mergedText: valid })

		const remoteValid = resolveByDiff3Merge({
			filePath: sessionPath,
			hasBase: false,
			baseContentText: '',
			localContentText: '{bad json',
			remoteContentText: valid,
		})
		expect(remoteValid).toEqual({ success: true, mergedText: valid })

		const bothInvalid = resolveByDiff3Merge({
			filePath: sessionPath,
			hasBase: false,
			baseContentText: '',
			localContentText: '{bad local',
			remoteContentText: '{bad remote',
		})
		expect(bothInvalid.success).toBe(false)
	})
})

describe('chat meta merge engine', () => {
	const metaPath = '.agents/nutstore-sync/chat-meta.json'

	it('merges concurrent new sessions and preserves pretty formatting under Diff3', () => {
		const base: ChatMetaFile = {
			activeSessionId: 's1',
			orderedSessionIds: ['s1'],
			sessions: {
				s1: { title: 'First', createdAt: 100, updatedAt: 100 },
			},
		}
		const local: ChatMetaFile = {
			activeSessionId: 's2',
			orderedSessionIds: ['s2', 's1'],
			sessions: {
				s1: { title: 'First', createdAt: 100, updatedAt: 100 },
				s2: { title: 'Local Chat', createdAt: 200, updatedAt: 200 },
			},
		}
		const remote: ChatMetaFile = {
			activeSessionId: 's3',
			orderedSessionIds: ['s3', 's1'],
			sessions: {
				s1: { title: 'First Updated', createdAt: 100, updatedAt: 150 },
				s3: { title: 'Remote Chat', createdAt: 300, updatedAt: 300 },
			},
		}

		const result = resolveByDiff3Merge({
			filePath: metaPath,
			hasBase: true,
			baseContentText: pretty(base),
			localContentText: pretty(local),
			remoteContentText: pretty(remote),
		})

		expect(result.success).toBe(true)
		expect(result.mergedText).not.toContain('<<<<<<<')
		expect(result.mergedText).toContain('\n  "orderedSessionIds"')

		const parsed = JSON.parse(result.mergedText!) as ChatMetaFile
		expect(parsed.orderedSessionIds).toEqual(['s3', 's2', 's1'])
		expect(parsed.sessions.s1.title).toBe('First Updated')
		expect(parsed.sessions.s2.title).toBe('Local Chat')
		expect(parsed.sessions.s3.title).toBe('Remote Chat')
		expect(parsed.activeSessionId).toBe('s3')
	})

	it('removes deleted session from orderedSessionIds and updates activeSessionId fallback', () => {
		const base: ChatMetaFile = {
			activeSessionId: 's1',
			orderedSessionIds: ['s1', 's2'],
			sessions: {
				s1: { title: 'One', createdAt: 100, updatedAt: 100 },
				s2: { title: 'Two', createdAt: 150, updatedAt: 150 },
			},
		}
		const local: ChatMetaFile = {
			activeSessionId: 's2',
			orderedSessionIds: ['s2'],
			sessions: {
				s2: { title: 'Two', createdAt: 150, updatedAt: 150 },
			},
		}
		const remote: ChatMetaFile = {
			activeSessionId: 's1',
			orderedSessionIds: ['s1', 's2', 's3'],
			sessions: {
				s1: { title: 'One', createdAt: 100, updatedAt: 100 },
				s2: { title: 'Two', createdAt: 150, updatedAt: 150 },
				s3: { title: 'Three', createdAt: 300, updatedAt: 300 },
			},
		}

		const result = resolveByDiff3Merge({
			filePath: metaPath,
			hasBase: true,
			baseContentText: pretty(base),
			localContentText: pretty(local),
			remoteContentText: pretty(remote),
		})

		expect(result.success).toBe(true)
		const parsed = JSON.parse(result.mergedText!) as ChatMetaFile
		expect(parsed.orderedSessionIds).toEqual(['s2', 's3'])
		expect(parsed.sessions.s1).toBeUndefined()
		expect(parsed.activeSessionId).toBe('s2')
	})
})
