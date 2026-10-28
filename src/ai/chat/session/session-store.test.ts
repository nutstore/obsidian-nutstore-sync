import { describe, expect, it, vi } from 'vitest'
import { Notice } from 'obsidian'
import { ChatState } from '~/ai/chat/runtime/chat-state'
import type { Selection } from '~/ai/chat/runtime/selection'
import type { ChatSession } from '~/ai/chat/domain'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import { SessionsFileBackend } from './session-files'
import { encodeChatSessionForStorage } from './session-persistence'
import { SessionStore, SessionUnavailableError } from './session-store'

vi.mock('obsidian', () => ({
	Notice: vi.fn(),
	normalizePath: (path: string) => path,
	Platform: { isWin: false, isMacOS: true, isLinux: false },
}))
vi.mock('~/i18n', () => ({ default: { t: (key: string) => key } }))

describe('session loading failures', () => {
	it('preserves prototype-named agent, operation and timing ids during normalization', () => {
		const master = createEmptyMasterAgent(1)
		master.subagents = Object.fromEntries([
			[
				'__proto__',
				{
					...createEmptyMasterAgent(2),
					id: 'child-子项-🌿',
				},
			],
		])
		master.operations = Object.fromEntries([['__proto__', []]])
		master.toolTimings = Object.fromEntries([['__proto__', { startedAt: 1 }]])
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'neutral-中性-🌿',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const store = new SessionStore(
			new ChatState(),
			{} as Selection,
			{} as SessionsFileBackend,
			{
				listSessionKeys: async () => [],
				getSession: async () => undefined,
				unsetSession: async () => {},
				getMeta: async () => ({ meta: null, index: [] }),
			},
		)
		const normalized = store.normalizeSession(session).session.subagents.master
		for (const map of [
			normalized.subagents,
			normalized.operations,
			normalized.toolTimings,
		]) {
			expect(Object.keys(map)).toEqual(['__proto__'])
			expect(Object.getPrototypeOf(map)).toBe(Object.prototype)
		}
	})

	it.each([null, undefined, { mode: 'summary', preservedTurnCount: null }])(
		'reports invalid checkpoint data through the unavailable-session boundary (%j)',
		async (data) => {
			vi.mocked(Notice).mockClear()
			const session: ChatSession = {
				schemaVersion: 2,
				id: 'neutral-中性-🌿',
				createdAt: 1,
				updatedAt: 1,
				subagents: { master: createEmptyMasterAgent(1) },
			}
			// Persisted JSON is untrusted, so deliberately bypass the source type.
			session.subagents.master.timeline = JSON.parse(
				JSON.stringify([
					{
						id: 'checkpoint-摘要-🌿',
						role: 'user',
						parts: [{ type: 'data-context-checkpoint', data }],
					},
				]),
			)
			const backend = Object.create(
				SessionsFileBackend.prototype,
			) as SessionsFileBackend
			vi.spyOn(backend, 'readSessionFile').mockResolvedValue({
				session: await encodeChatSessionForStorage(session),
			})
			vi.spyOn(backend, 'listSessionIds').mockResolvedValue([session.id])
			vi.spyOn(backend, 'readMetaFile').mockResolvedValue(null)
			const state = new ChatState()
			const store = new SessionStore(state, {} as Selection, backend, {
				listSessionKeys: async () => [],
				getSession: async () => undefined,
				unsetSession: async () => {},
				getMeta: async () => ({ meta: null, index: [] }),
			})
			vi.spyOn(store, 'persistMetaAndIndex').mockResolvedValue()
			await expect(store.loadSessionById(session.id)).rejects.toBeInstanceOf(
				SessionUnavailableError,
			)
			expect(Notice).toHaveBeenCalledWith(
				'chatbox.errors.corruptSessionFile',
				10000,
			)
			expect(state.loadedSessions.has(session.id)).toBe(false)
		},
	)
})
