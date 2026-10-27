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
	const backend = new SessionsFileBackend(app)
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
	const backend = new SessionsFileBackend(app)
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

export async function exportsImagesThroughBrowserTransport(app: App) {
	const { decodeChatSessionFromStorage } =
		await import('~/ai/chat/session/session-persistence')
	const { exportSessionToMarkdownFile } =
		await import('~/ai/chat/messages/export-session')
	const session = decodeChatSessionFromStorage(
		sessionSnapshot('neutral-export'),
	)
	assert('subagents' in session, 'Expected a current session snapshot')
	const content = new TextEncoder().encode(
		'<svg xmlns="http://www.w3.org/2000/svg"><text>Neutral 中性 🌱</text></svg>',
	)
	const remoteUrl = 'https://example.test/neutral-image.svg'
	const resourceUrl = URL.createObjectURL(
		new Blob([content], { type: 'image/svg+xml' }),
	)
	const originalFetch = window.fetch
	const calls: string[] = []
	window.fetch = async (input, init) => {
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: input.url
		calls.push(url)
		if (url === remoteUrl)
			return new Response(content, {
				headers: { 'content-type': 'image/svg+xml' },
			})
		return originalFetch.call(window, input, init)
	}
	try {
		session.subagents.master.timeline = [
			{
				id: 'neutral-image-message',
				role: 'user',
				parts: [
					{ type: 'text', text: 'Neutral image 中性图片 🌱' },
					...[remoteUrl, resourceUrl].map((url) => ({
						type: 'data-model-file' as const,
						data: {
							file: {
								type: 'file' as const,
								mediaType: 'image/svg+xml',
								data: url,
							},
						},
					})),
				],
			},
		]
		const file = await exportSessionToMarkdownFile({
			vault: app.vault,
			manifestId: 'neutral-export',
			manifestVersion: '1.0.0',
			session,
			title: 'Neutral export 中性导出 🌱',
			includeToolMessages: false,
		})
		const markdown = await app.vault.read(file)
		assert(
			calls.includes(remoteUrl) && calls.includes(resourceUrl),
			'Image export bypassed browser transport',
		)
		const references = [...markdown.matchAll(/!\[\]\(([^)]+)\)/g)]
		assert(
			references.length === 2,
			'Export did not save both remote and browser-owned images',
		)
		for (const reference of references) {
			const path = `${file.parent!.path}/${reference[1]}`
			const bytes = await app.vault.adapter.readBinary(path)
			assert(
				new TextDecoder().decode(bytes) === new TextDecoder().decode(content),
				'Export changed Unicode image bytes',
			)
		}
	} finally {
		window.fetch = originalFetch
		URL.revokeObjectURL(resourceUrl)
	}
}
