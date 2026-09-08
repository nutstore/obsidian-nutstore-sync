import { describe, expect, it } from 'vitest'
import type { ChatSession, LegacyChatSession } from '~/ai/chat/domain'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import { normalizeRehydratedExecution } from '~/ai/chat/session/rehydration-execution'
import {
	migrateChatSession,
	normalizeLegacySession,
} from '~/ai/chat/session/session-migration'
import {
	decodeChatSessionFromStorage,
	encodeChatSessionForStorage,
	type PersistedChatSession,
} from '~/ai/chat/session/session-persistence'

describe('chat session persistence', () => {
	it('round-trips a subagent model snapshot and accepts legacy agents without one', async () => {
		const master = createEmptyMasterAgent(1)
		master.subagents['neutral-agent'] = {
			...createEmptyMasterAgent(2),
			id: 'neutral-agent',
			type: 'explorer',
			status: 'queued',
			model: { providerId: '中性-provider', modelId: 'model-🌿' },
		}
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'neutral-session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}

		const decoded = decodeChatSessionFromStorage(
			await encodeChatSessionForStorage(session),
		) as ChatSession
		expect(decoded.subagents.master.subagents['neutral-agent'].model).toEqual({
			providerId: '中性-provider',
			modelId: 'model-🌿',
		})

		delete (
			decoded.subagents.master.subagents['neutral-agent'] as {
				model?: unknown
			}
		).model
		expect(
			migrateChatSession(decoded).session.subagents.master.subagents[
				'neutral-agent'
			].model,
		).toBeUndefined()
	})

	it('cleans incomplete execution state from every agent on rehydrate', () => {
		const master = createEmptyMasterAgent(1)
		master.timeline.push({
			id: 'incomplete-tool',
			role: 'assistant',
			metadata: { createdAt: 1 },
			parts: [
				{
					type: 'dynamic-tool',
					toolName: 'neutral-tool',
					toolCallId: 'neutral-call',
					state: 'input-available',
					input: { text: '中性 🌿' },
				},
			],
		})
		const idle = {
			...createEmptyMasterAgent(2),
			id: 'idle-child',
			type: 'subagent',
			status: 'idle' as const,
			pendingInputs: [
				{
					id: 'idle-input',
					role: 'user' as const,
					metadata: { createdAt: 1 },
					parts: [{ type: 'text' as const, text: '中性 input 🌿' }],
				},
			],
		}
		const queued = {
			...createEmptyMasterAgent(3),
			id: 'queued-child',
			type: 'subagent',
			status: 'queued' as const,
			pendingInputs: idle.pendingInputs.slice(),
		}
		const running = {
			...createEmptyMasterAgent(4),
			id: 'running-child',
			type: 'subagent',
			status: 'running' as const,
			pendingInputs: idle.pendingInputs.slice(),
		}
		const completed = {
			...createEmptyMasterAgent(5),
			id: 'completed-child',
			type: 'subagent',
			status: 'completed' as const,
			pendingInputs: idle.pendingInputs.slice(),
			timeline: [
				{
					id: 'completed-incomplete-tool',
					role: 'assistant' as const,
					metadata: { createdAt: 1 },
					parts: [
						{
							type: 'dynamic-tool' as const,
							toolName: 'neutral-child-tool',
							toolCallId: 'neutral-child-call',
							state: 'input-available' as const,
							input: { text: '中性子任务 🌿' },
						},
					],
				},
			],
		}
		master.subagents[idle.id] = idle
		master.subagents[queued.id] = queued
		master.subagents[running.id] = running
		master.subagents[completed.id] = completed
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'rehydrated-session',
			createdAt: 1,
			updatedAt: 2,
			subagents: { master },
		}
		const changed = normalizeRehydratedExecution(session)
		const children = Object.values(session.subagents.master.subagents)

		expect(changed).toBe(true)
		expect(children.map((agent) => agent.status)).toEqual([
			'cancelled',
			'cancelled',
			'cancelled',
			'completed',
		])
		expect(children.map((agent) => agent.pendingInputs)).toEqual([
			[],
			[],
			[],
			[],
		])
		expect(master.timeline).toEqual([])
		expect(completed.timeline).toEqual([])
	})

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
		master.toolTimings.call = { startedAt: 10, finishedAt: 35 }
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
		expect(decoded.subagents.master.toolTimings.call).toEqual({
			startedAt: 10,
			finishedAt: 35,
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

	it('round-trips ArrayBuffer and Uint8Array binary values', async () => {
		const bytes = new TextEncoder().encode('中性 text 🙂')
		const arrayBuffer = bytes.slice().buffer
		const master = createEmptyMasterAgent(1)
		master.timeline.push({
			id: 'binary',
			role: 'assistant',
			parts: [
				{
					type: 'dynamic-tool',
					toolName: 'binary-test',
					toolCallId: 'binary-call',
					state: 'input-available',
					input: { arrayBuffer, uint8Array: bytes },
				},
			],
		})
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'binary-session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}

		const decoded = decodeChatSessionFromStorage(
			await encodeChatSessionForStorage(session),
		) as ChatSession
		const part = decoded.subagents.master.timeline[0]?.parts[0]
		if (part?.type !== 'dynamic-tool') {
			throw new Error('Expected a dynamic tool part')
		}
		const input = part.input as {
			arrayBuffer: ArrayBuffer
			uint8Array: Uint8Array
		}
		expect(input.arrayBuffer).toBeInstanceOf(ArrayBuffer)
		expect(input.uint8Array).toBeInstanceOf(Uint8Array)
		expect(Array.from(new Uint8Array(input.arrayBuffer))).toEqual(
			Array.from(bytes),
		)
		expect(Array.from(input.uint8Array)).toEqual(Array.from(bytes))
	})

	it('rejects unsupported binary views', async () => {
		const bytes = new TextEncoder().encode('中性 text 🙂')
		const master = createEmptyMasterAgent(1)
		master.timeline.push({
			id: 'unsupported-binary',
			role: 'assistant',
			parts: [
				{
					type: 'dynamic-tool',
					toolName: 'binary-test',
					toolCallId: 'unsupported-binary-call',
					state: 'input-available',
					input: { dataView: new DataView(bytes.buffer) },
				},
			],
		})
		const session: ChatSession = {
			schemaVersion: 2,
			id: 'unsupported-binary-session',
			createdAt: 1,
			updatedAt: 1,
			subagents: { master },
		}

		await expect(encodeChatSessionForStorage(session)).rejects.toThrow(
			'Only ArrayBuffer and Uint8Array are supported',
		)
	})

	it('decodes typed-array kinds written by older V2 sessions', () => {
		const bareUint16Array = new Uint16Array([0x41, 0x7dfe])
		const stored = {
			schemaVersion: 2,
			id: 'legacy-binary-session',
			createdAt: 1,
			updatedAt: 1,
			binary: {
				bareUint16Array,
				dataView: {
					__nutstore_chat_binary_v2: true,
					kind: 'dataview',
					data: 'QQD-fQ',
				},
				uint16Array: {
					__nutstore_chat_binary_v2: true,
					kind: 'Uint16Array',
					data: 'QQD-fQ',
				},
				buffer: {
					__nutstore_chat_binary_v2: true,
					kind: 'Buffer',
					data: 'QQD-fQ',
				},
			},
		} as unknown as PersistedChatSession

		const decoded = decodeChatSessionFromStorage(stored) as unknown as {
			binary: {
				bareUint16Array: Uint16Array
				dataView: DataView
				uint16Array: Uint16Array
				buffer: Uint8Array
			}
		}

		expect(decoded.binary.dataView).toBeInstanceOf(DataView)
		expect(decoded.binary.bareUint16Array).toBe(bareUint16Array)
		expect(Array.from(new Uint8Array(decoded.binary.dataView.buffer))).toEqual([
			65, 0, 254, 125,
		])
		expect(decoded.binary.uint16Array).toBeInstanceOf(Uint16Array)
		expect(
			Array.from(new Uint8Array(decoded.binary.uint16Array.buffer)),
		).toEqual([65, 0, 254, 125])
		expect(decoded.binary.buffer.constructor.name).toBe('Buffer')
		expect(Array.from(decoded.binary.buffer)).toEqual([65, 0, 254, 125])
	})

	it('restores a legacy V1 ArrayBuffer-backed blob record on decode', async () => {
		const artifact = {
			schemaVersion: 2,
			id: 'legacy',
			createdAt: 1,
			updatedAt: 1,
			modelFile: {
				type: 'file',
				mimeType: 'text/plain',
				data: new Uint8Array([104, 105]).buffer,
			},
			blob: {
				__nutstore_chat_blob_v1: true,
				type: 'image/png',
				data: new Uint8Array([1, 2, 3]).buffer,
			},
		}
		const decoded = decodeChatSessionFromStorage(
			artifact as unknown as PersistedChatSession,
		) as unknown as {
			blob: Blob
			modelFile: { data: Uint8Array }
		}
		expect(decoded.blob).toBeInstanceOf(Blob)
		expect(new Uint8Array(await decoded.blob.arrayBuffer())).toEqual(
			new Uint8Array([1, 2, 3]),
		)
		expect(decoded.modelFile.data).toBeInstanceOf(ArrayBuffer)
		expect(new Uint8Array(decoded.modelFile.data)).toEqual(
			new Uint8Array([104, 105]),
		)
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

	it('normalizes malformed legacy collections before migration', () => {
		const normalized = normalizeLegacySession({
			id: 'legacy',
			createdAt: 1,
			updatedAt: 0,
			activeFragmentId: 'fragment',
			fragments: [
				{
					id: 'fragment',
					createdAt: 1,
					updatedAt: 0,
					readVaultPaths: ['note.md', '', 1] as string[],
					messages: null as never,
				},
			],
		})

		expect(normalized.fragments?.[0]).toMatchObject({
			updatedAt: 1,
			readVaultPaths: ['note.md'],
			messages: [],
		})
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
