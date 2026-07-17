import { describe, expect, it } from 'vitest'
import type { ChatSession, LegacyChatSession } from '~/ai/chat/domain'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import { migrateChatSession } from '~/ai/chat/session/session-migration'
import {
	decodeChatSessionFromStorage,
	encodeChatSessionForStorage,
} from '~/ai/chat/session/session-persistence'

describe('chat session persistence', () => {
	it('captures an isolated V2 UIMessage snapshot', async () => {
		const master = createEmptyMasterAgent(1)
		const toolInput = { nested: { value: 'before' } }
		master.timeline.push({
			id: 'message',
			role: 'assistant',
			metadata: { createdAt: 1 },
			parts: [
				{
					type: 'dynamic-tool',
					toolName: 'demo',
					toolCallId: 'call',
					state: 'input-available',
					input: toolInput,
				},
			],
		})
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const encodedPromise = encodeChatSessionForStorage(session)
		toolInput.nested.value = 'after'
		const decoded = decodeChatSessionFromStorage(
			await encodedPromise,
		) as ChatSession
		const part = decoded.subagents.master.timeline[0].parts[0]
		expect(part).toMatchObject({
			type: 'dynamic-tool',
			input: { nested: { value: 'before' } },
		})
	})

	it('round-trips blobs nested in UI data parts', async () => {
		const master = createEmptyMasterAgent(1)
		master.timeline.push({
			id: 'message',
			role: 'user',
			parts: [
				{
					type: 'data-user-context',
					data: {
						items: [
							{
								type: 'image',
								hash: 'image',
								blob: new Blob(['image'], { type: 'image/png' }),
								mimeType: 'image/png',
								size: 5,
							},
						],
					},
				},
			],
		})
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}
		const decoded = decodeChatSessionFromStorage(
			await encodeChatSessionForStorage(session),
		) as ChatSession
		const data = decoded.subagents.master.timeline[0].parts[0]
		if (data.type !== 'data-user-context')
			throw new Error('Expected user context')
		const restored = (data.data as { items: Array<{ blob: Blob }> }).items[0]
			.blob
		expect(restored).toBeInstanceOf(Blob)
		expect(await restored.text()).toBe('image')
	})

	it('migrates V1 fragments losslessly and is idempotent', () => {
		const legacy: LegacyChatSession & {
			permissions: { allow: Array<{ operation: string; path: string }> }
		} = {
			id: 'legacy',
			createdAt: 1,
			updatedAt: 2,
			permissions: {
				allow: [{ operation: 'write', path: 'legacy.md' }],
			},
			activeFragmentId: 'f2',
			fragments: [
				{
					id: 'f1',
					createdAt: 1,
					updatedAt: 1,
					messages: [
						{
							id: 'u1',
							createdAt: 1,
							message: { role: 'user', content: 'hello' },
						},
					],
				},
				{
					id: 'f2',
					createdAt: 2,
					updatedAt: 2,
					summary: 'summary',
					messages: [
						{
							id: 'summary-copy',
							createdAt: 2,
							message: { role: 'user', content: 'summary' },
						},
					],
				},
			],
		}
		const first = migrateChatSession(legacy)
		expect(first.changed).toBe(true)
		expect(first.session).not.toHaveProperty('permissions')
		expect(first.session.subagents.master).not.toHaveProperty('permissionMode')
		expect(first.session.subagents.master.timeline).toHaveLength(2)
		expect(first.session.subagents.master.timeline[1].parts[0]).toMatchObject({
			type: 'data-context-checkpoint',
			data: { mode: 'summary', summary: 'summary' },
		})
		const second = migrateChatSession(first.session)
		expect(second.changed).toBe(false)
		expect(second.session).toBe(first.session)
	})

	it('attaches V1 tool-record metadata once when a message has multiple results', () => {
		const legacy: LegacyChatSession = {
			id: 'legacy-tools',
			createdAt: 1,
			updatedAt: 2,
			activeFragmentId: 'fragment',
			fragments: [
				{
					id: 'fragment',
					createdAt: 1,
					updatedAt: 2,
					messages: [
						{
							id: 'assistant',
							createdAt: 1,
							message: {
								role: 'assistant',
								content: ['one', 'two'].map((toolCallId) => ({
									type: 'tool-call' as const,
									toolCallId,
									toolName: 'read',
									input: {},
								})),
							},
						},
						{
							id: 'tools',
							createdAt: 2,
							message: {
								role: 'tool',
								content: ['one', 'two'].map((toolCallId) => ({
									type: 'tool-result' as const,
									toolCallId,
									toolName: 'read',
									output: { type: 'text' as const, value: toolCallId },
								})),
							},
							todos: [
								{ content: 'once', status: 'pending', priority: 'medium' },
							],
							reversibleOps: [
								{
									vaultPath: 'note.md',
									operation: 'create',
									before: { kind: 'file' },
								},
							],
						},
					],
				},
			],
		}

		const master = migrateChatSession(legacy).session.subagents.master
		expect(master.timeline).toHaveLength(1)
		expect(
			master.timeline[0].parts.filter((part) => part.type === 'dynamic-tool'),
		).toHaveLength(2)
		expect(
			master.timeline[0].parts.filter((part) => part.type === 'data-todos'),
		).toHaveLength(1)
		expect(master.operations).toEqual({
			assistant: [
				{
					vaultPath: 'note.md',
					operation: 'create',
					before: { kind: 'file' },
				},
			],
		})
	})
})
