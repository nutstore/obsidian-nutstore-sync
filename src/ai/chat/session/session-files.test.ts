import { describe, expect, it } from 'vitest'
import { createMemoryVault } from 'test/mocks/memory-vault'
import type { PersistedChatSession } from '~/ai/chat/session/session-persistence'
import {
	CHAT_SESSIONS_DIR,
	SessionFileCorruptError,
	SessionsFileBackend,
} from '~/ai/chat/session/session-files'

function createSnapshot(id: string): PersistedChatSession {
	return {
		schemaVersion: 2,
		id,
		createdAt: 1,
		updatedAt: 2,
		subagents: {
			master: {
				id: 'master',
				type: 'master',
				status: 'idle',
				createdAt: 1,
				timeline: [],
				pendingInputs: [],
				operations: {},
				toolTimings: {},
				subagents: {},
			},
		},
	} as unknown as PersistedChatSession
}

describe('SessionsFileBackend', () => {
	it('round-trips a session file with its title', async () => {
		const { vault, files } = createMemoryVault()
		const backend = new SessionsFileBackend(vault)
		await backend.writeSessionFile('session-1', {
			session: createSnapshot('session-1'),
			title: 'Hello / 你好',
		})
		const payload = await backend.readSessionFile('session-1')
		expect(payload.title).toBe('Hello / 你好')
		expect(payload.session.id).toBe('session-1')
		const content = files.get(`${CHAT_SESSIONS_DIR}/session-1.json`)?.content
		expect(content).toContain('\n  "session": {\n')
		expect(content).toContain('\n    "id": "session-1",\n')
		expect(content?.endsWith('\n')).toBe(true)
	})

	it('leaves no temp files after an atomic write', async () => {
		const { vault, files } = createMemoryVault()
		const backend = new SessionsFileBackend(vault)
		await backend.writeSessionFile('session-1', {
			session: createSnapshot('session-1'),
		})
		await backend.writeSessionFile('session-1', {
			session: createSnapshot('session-1'),
			title: 'updated',
		})
		const children = [...files.entries()]
			.filter(([, entry]) => entry.type === 'file')
			.map(([path]) => path)
			.filter((path) => path.includes(CHAT_SESSIONS_DIR))
		expect(children).toEqual([`${CHAT_SESSIONS_DIR}/session-1.json`])
	})

	it('lists only session json files', async () => {
		const { vault } = createMemoryVault()
		const backend = new SessionsFileBackend(vault)
		await backend.writeSessionFile('session-a', {
			session: createSnapshot('session-a'),
		})
		await backend.writeSessionFile('session-b', {
			session: createSnapshot('session-b'),
		})
		expect((await backend.listSessionIds()).sort()).toEqual([
			'session-a',
			'session-b',
		])
		expect(await backend.hasAnySessionFiles()).toBe(true)
	})

	it('returns empty when no session files exist', async () => {
		const { vault } = createMemoryVault()
		const backend = new SessionsFileBackend(vault)
		expect(await backend.listSessionIds()).toEqual([])
		expect(await backend.hasAnySessionFiles()).toBe(false)
	})

	it('reports a corrupt session file as a typed error', async () => {
		const { vault } = createMemoryVault({
			'.agents/nutstore-sync/sessions/broken.json': '{oops',
		})
		const backend = new SessionsFileBackend(vault)
		await expect(backend.readSessionFile('broken')).rejects.toBeInstanceOf(
			SessionFileCorruptError,
		)
	})

	it('throws a not-found error for a missing session file', async () => {
		const { vault } = createMemoryVault()
		const backend = new SessionsFileBackend(vault)
		await expect(backend.readSessionFile('missing')).rejects.toThrow(
			/Session file not found/,
		)
	})

	it('rejects a session file that is not an object', async () => {
		const { vault } = createMemoryVault({
			'.agents/nutstore-sync/sessions/weird.json': 'null',
		})
		const backend = new SessionsFileBackend(vault)
		await expect(backend.readSessionFile('weird')).rejects.toBeInstanceOf(
			SessionFileCorruptError,
		)
	})

	it('deletes a session file', async () => {
		const { vault } = createMemoryVault()
		const backend = new SessionsFileBackend(vault)
		await backend.writeSessionFile('session-1', {
			session: createSnapshot('session-1'),
		})
		await backend.deleteSessionFile('session-1')
		expect(await backend.listSessionIds()).toEqual([])
	})

	it('round-trips the meta file and tolerates corruption', async () => {
		const { vault, files } = createMemoryVault()
		const backend = new SessionsFileBackend(vault)
		const meta = {
			activeSessionId: 'session-1',
			orderedSessionIds: ['session-1'],
			sessions: {
				'session-1': {
					title: 'Title',
					createdAt: 1,
					updatedAt: 2,
				},
			},
		}
		await backend.writeMetaFile(meta)
		expect(await backend.readMetaFile()).toEqual(meta)
		expect(
			files.get('.agents/nutstore-sync/chat-meta.json')?.content,
		).toContain('\n  "orderedSessionIds": [\n')

		const { vault: corruptVault } = createMemoryVault({
			'.agents/nutstore-sync/chat-meta.json': '[[[',
		})
		const corruptBackend = new SessionsFileBackend(corruptVault)
		expect(await corruptBackend.readMetaFile()).toBeNull()
	})
})
