import type { App } from 'obsidian'
import type { PersistedChatSession } from '~/ai/chat/session/session-persistence'
import { assert } from './assert'

function sessionSnapshot(id: string): PersistedChatSession {
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
	} as PersistedChatSession
}

export async function persistsChatSessions(app: App) {
	const { SessionsFileBackend } =
		await import('~/ai/chat/session/session-files')
	const backend = new SessionsFileBackend(app.vault)
	const id = 'session-neutral-🌱'
	await backend.writeSessionFile(id, {
		session: sessionSnapshot(id),
		title: 'neutral session / 中性会话 🌱',
	})
	const payload = await backend.readSessionFile(id)
	assert(payload.session.id === id, 'Session ID did not persist')
	assert(
		payload.title === 'neutral session / 中性会话 🌱',
		'Session title did not persist',
	)
	assert(
		(await backend.listSessionIds()).includes(id),
		'Session file was not listed',
	)
	await backend.deleteSessionFile(id)
	assert(
		!(await backend.listSessionIds()).includes(id),
		'Session file was not deleted',
	)
}

export async function toleratesCorruptChatMeta(app: App) {
	const { SessionsFileBackend } =
		await import('~/ai/chat/session/session-files')
	const backend = new SessionsFileBackend(app.vault)
	const meta = { orderedSessionIds: [], sessions: {} }
	await backend.writeMetaFile(meta)
	assert(
		JSON.stringify(await backend.readMetaFile()) === JSON.stringify(meta),
		'Chat meta file did not round-trip',
	)
	await app.vault.adapter.write('.agents/nutstore-sync/chat-meta.json', '[[[')
	assert(
		(await backend.readMetaFile()) === null,
		'Corrupt chat meta file was accepted',
	)
}
