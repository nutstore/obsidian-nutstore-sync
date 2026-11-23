import type { App } from 'obsidian'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryVault } from '@test/harness/memory-vault'
import { exportSessionToMarkdownFile } from '~/ai/chat/messages/export-session'
import { SessionsFileBackend } from '~/ai/chat/session/session-files'
import {
	decodeChatSessionFromStorage,
	type PersistedChatSession,
} from '~/ai/chat/session/session-persistence'

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

describe('SessionsFileBackend and session image export', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('persists, lists, reads, and deletes chat sessions with CJK/Emoji IDs and titles', async () => {
		const mem = new MemoryVault({ name: 'SessionFilesVault' })
		const backend = new SessionsFileBackend(mem.app as unknown as App)
		const id = 'session-neutral-🌱'

		await backend.writeSessionFile(id, {
			session: sessionSnapshot(id),
			title: 'neutral session / 中性会话 🌱',
		})

		const payload = await backend.readSessionFile(id)
		expect(payload.session.id).toBe(id)
		expect(payload.title).toBe('neutral session / 中性会话 🌱')
		expect(await backend.listSessionIds()).toContain(id)

		await backend.deleteSessionFile(id)
		expect(await backend.listSessionIds()).not.toContain(id)
	})

	it('round-trips chat meta and tolerates a corrupt meta file', async () => {
		const mem = new MemoryVault({ name: 'CorruptMetaVault' })
		const app = mem.app as unknown as App
		const backend = new SessionsFileBackend(app)
		const meta = { orderedSessionIds: [], sessions: {} }

		await backend.writeMetaFile(meta)
		expect(await backend.readMetaFile()).toEqual(meta)

		await app.vault.adapter.write('.agents/nutstore-sync/chat-meta.json', '[[[')
		expect(await backend.readMetaFile()).toBeNull()
	})

	it('exports remote and blob images via browser fetch preserving exact UTF-8 SVG bytes', async () => {
		const mem = new MemoryVault({ name: 'ImageExportVault' })
		const app = mem.app as unknown as App
		const session = decodeChatSessionFromStorage(
			sessionSnapshot('neutral-export'),
		)
		if (!('subagents' in session)) {
			throw new Error('Expected a current V2 session snapshot')
		}

		const svgBytes = new TextEncoder().encode(
			'<svg xmlns="http://www.w3.org/2000/svg"><text>Neutral 中性 🌱</text></svg>',
		)
		const remoteUrl = 'https://example.test/neutral-image.svg'
		const resourceUrl = URL.createObjectURL(
			new Blob([svgBytes], { type: 'image/svg+xml' }),
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
			if (url === remoteUrl || url === resourceUrl) {
				return new Response(svgBytes, {
					headers: { 'content-type': 'image/svg+xml' },
				})
			}
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
				pluginVersion: '1.0.0',
				session,
				title: 'Neutral export 中性导出 🌱',
				includeToolMessages: false,
			})
			const markdown = await app.vault.read(file)
			expect(calls).toContain(remoteUrl)
			expect(calls).toContain(resourceUrl)

			const references = [...markdown.matchAll(/!\[\]\(([^)]+)\)/g)]
			expect(references).toHaveLength(2)
			for (const reference of references) {
				const assetPath = `${file.parent!.path}/${reference[1]}`
				const bytes = await app.vault.adapter.readBinary(assetPath)
				expect(new TextDecoder().decode(bytes)).toBe(
					new TextDecoder().decode(svgBytes),
				)
			}
		} finally {
			window.fetch = originalFetch
			URL.revokeObjectURL(resourceUrl)
		}
	})
})
