import { describe, expect, it } from 'vitest'
import { TFile, TFolder, type App, type Vault } from 'obsidian'
import { createAITools } from '~/ai/tools/tools'
import {
	createFragmentReadTracker,
	type ReadTracker,
} from '~/ai/tools/file-operation'
import type {
	AIToolCall,
	AIToolExecutionContext,
	AIToolDefinition,
} from '~/ai/core/types'
import type { ChatFragment, ChatSession } from '~/ai/chat/domain'
import { ToolExecutor } from '~/ai/chat/runtime/tool-executor'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import type { Selection } from '~/ai/chat/runtime/selection'
import { SessionStore } from '~/ai/chat/session/session-store'

interface MockFile {
	path: string
	content: string
}

function createMockApp(files: MockFile[]) {
	const store = new Map<string, string>()
	for (const f of files) {
		store.set(f.path, f.content)
	}

	const vault = {
		getAbstractFileByPath(path: string) {
			if (!store.has(path)) return null
			return Object.assign(new TFile(), {
				path,
				name: path.split('/').pop() ?? path,
				stat: { size: store.get(path)!.length, mtime: 0 },
			})
		},
		async cachedRead(file: { path: string }) {
			return store.get(file.path) ?? ''
		},
		async modify(file: { path: string }, content: string) {
			store.set(file.path, content)
		},
	} as unknown as Vault

	return {
		app: { vault } as unknown as App,
		store,
	}
}

function createMockVaultForExecutor(files: MockFile[]) {
	const store = new Map<string, string>()
	for (const f of files) {
		store.set(f.path, f.content)
	}

	function buildFolder(path: string, name: string, children: unknown[]) {
		return Object.assign(new TFolder(), { path, name, children })
	}

	function getRoot() {
		const topLevel = new Map<string, { path: string; isDir: boolean }>()
		for (const key of store.keys()) {
			const parts = key.split('/')
			const top = parts[0]
			if (parts.length === 1) {
				topLevel.set(top, { path: top, isDir: false })
			} else {
				topLevel.set(top, { path: top, isDir: true })
			}
		}
		const children = [...topLevel.values()].map((entry) =>
			entry.isDir
				? buildFolder(entry.path, entry.path, [])
				: Object.assign(new TFile(), {
						path: entry.path,
						name: entry.path,
						stat: { size: store.get(entry.path)!.length, mtime: 0 },
					}),
		)
		return buildFolder('', '', children)
	}

	const vault = {
		getRoot,
		getAbstractFileByPath(path: string) {
			if (!store.has(path)) return null
			return Object.assign(new TFile(), {
				path,
				name: path.split('/').pop() ?? path,
				stat: { size: store.get(path)!.length, mtime: 0 },
			})
		},
		async readBinary(file: { path: string }) {
			if (!store.has(file.path)) throw new Error(`missing: ${file.path}`)
			return new TextEncoder().encode(store.get(file.path)!).buffer
		},
		async cachedRead(file: { path: string }) {
			return store.get(file.path) ?? ''
		},
		async modifyBinary(file: { path: string }, data: ArrayBuffer) {
			store.set(file.path, new TextDecoder().decode(data))
		},
		async modify(file: { path: string }, content: string) {
			store.set(file.path, content)
		},
		async createBinary(path: string, data: ArrayBuffer) {
			store.set(path, new TextDecoder().decode(data))
		},
		async createFolder(_path: string) {},
		adapter: {
			async exists(path: string) {
				return store.has(path)
			},
			async stat(path: string) {
				if (!store.has(path)) return null
				return {
					type: 'file' as const,
					mtime: 0,
					size: store.get(path)!.length,
				}
			},
			async readBinary(path: string) {
				return new TextEncoder().encode(store.get(path)!).buffer
			},
			async writeBinary(path: string, data: ArrayBuffer) {
				store.set(path, new TextDecoder().decode(data))
			},
			async write(path: string, data: string) {
				store.set(path, data)
			},
			async mkdir(_path: string) {},
			async remove(path: string) {
				store.delete(path)
			},
			async rmdir(_path: string, _recursive: boolean) {},
		},
		configDir: '.obsidian',
	} as unknown as Vault

	return {
		vault,
		store,
	}
}

function findTool(tools: AIToolDefinition[], name: string) {
	const tool = tools.find((t) => t.name === name)
	if (!tool) throw new Error(`tool not found: ${name}`)
	return tool
}

function makeContext(
	session: ChatSession,
	readTracker?: ReadTracker,
): AIToolExecutionContext {
	return {
		session,
		depth: 0,
		maxDepth: 2,
		readTracker,
	}
}

function makeSession(fragment?: ChatFragment): ChatSession {
	const frag = fragment ?? {
		id: 'f1',
		createdAt: 0,
		updatedAt: 0,
		messages: [],
	}
	return {
		id: 's1',
		createdAt: 0,
		updatedAt: 0,
		fragments: [frag],
		activeFragmentId: frag.id,
		tasks: [],
	}
}

async function callEditFile(
	app: App,
	params: { path: string; oldText: string; newText: string },
	context: AIToolExecutionContext,
) {
	const tools = createAITools(app, { permissionGuard: undefined })
	const tool = findTool(tools, 'edit_file')
	const parsed = tool.inputSchema.parse(params)
	return tool.execute(parsed, context)
}

describe('edit_file read-gate', () => {
	it('blocks edit when the file has not been read in a previous batch', async () => {
		const { app } = createMockApp([
			{ path: 'notes/x.md', content: 'hello world' },
		])
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const session = makeSession(fragment)
		const tracker = createFragmentReadTracker(fragment)
		const context = makeContext(session, tracker)

		await expect(
			callEditFile(
				app,
				{ path: 'notes/x.md', oldText: 'hello', newText: 'hi' },
				context,
			),
		).rejects.toThrow(/read .*notes\/x\.md/i)
	})

	it('allows edit after the file was read in a previous batch', async () => {
		const { app, store } = createMockApp([
			{ path: 'notes/x.md', content: 'hello world' },
		])
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const session = makeSession(fragment)

		const batch1Tracker = createFragmentReadTracker(fragment)
		batch1Tracker.markRead('notes/x.md')

		const batch2Tracker = createFragmentReadTracker(fragment)
		const context = makeContext(session, batch2Tracker)

		const result = await callEditFile(
			app,
			{ path: 'notes/x.md', oldText: 'hello', newText: 'hi' },
			context,
		)

		expect(result.result).toEqual({ replaced: true })
		expect(store.get('notes/x.md')).toBe('hi world')
	})

	it('allows edit with VAULT_MOUNT_POINT prefix after read in previous batch', async () => {
		const { app, store } = createMockApp([
			{ path: 'notes/x.md', content: 'hello world' },
		])
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const session = makeSession(fragment)

		const batch1Tracker = createFragmentReadTracker(fragment)
		batch1Tracker.markRead('notes/x.md')

		const batch2Tracker = createFragmentReadTracker(fragment)
		const context = makeContext(session, batch2Tracker)

		const result = await callEditFile(
			app,
			{ path: '/vault/notes/x.md', oldText: 'hello', newText: 'hi' },
			context,
		)

		expect(result.result).toEqual({ replaced: true })
		expect(store.get('notes/x.md')).toBe('hi world')
	})

	it('blocks edit in a new fragment (segment reset)', async () => {
		const { app } = createMockApp([
			{ path: 'notes/x.md', content: 'hello world' },
		])
		const oldFragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
			readVaultPaths: ['notes/x.md'],
		}
		const newFragment: ChatFragment = {
			id: 'f2',
			createdAt: 1,
			updatedAt: 1,
			messages: [],
		}
		const session: ChatSession = {
			id: 's1',
			createdAt: 0,
			updatedAt: 0,
			fragments: [oldFragment, newFragment],
			activeFragmentId: 'f2',
			tasks: [],
		}
		const tracker = createFragmentReadTracker(newFragment)
		const context = makeContext(session, tracker)

		await expect(
			callEditFile(
				app,
				{ path: 'notes/x.md', oldText: 'hello', newText: 'hi' },
				context,
			),
		).rejects.toThrow(/read .*notes\/x\.md/i)
	})

	it('fails closed (blocks) when readTracker is undefined', async () => {
		const { app } = createMockApp([
			{ path: 'notes/x.md', content: 'hello world' },
		])
		const session = makeSession()
		const context = makeContext(session, undefined)

		await expect(
			callEditFile(
				app,
				{ path: 'notes/x.md', oldText: 'hello', newText: 'hi' },
				context,
			),
		).rejects.toThrow(/read .*notes\/x\.md/i)
	})

	it('blocks edit when bash cat and edit_file share the same batch tracker (race guard)', async () => {
		const { app } = createMockApp([
			{ path: 'notes/x.md', content: 'hello world' },
		])
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const session = makeSession(fragment)

		const sharedTracker = createFragmentReadTracker(fragment)
		sharedTracker.markRead('notes/x.md')
		const context = makeContext(session, sharedTracker)

		await expect(
			callEditFile(
				app,
				{ path: 'notes/x.md', oldText: 'hello', newText: 'hi' },
				context,
			),
		).rejects.toThrow(/read .*notes\/x\.md/i)

		expect(fragment.readVaultPaths).toEqual(['notes/x.md'])

		const nextBatchTracker = createFragmentReadTracker(fragment)
		const nextContext = makeContext(session, nextBatchTracker)
		const result = await callEditFile(
			app,
			{ path: 'notes/x.md', oldText: 'hello', newText: 'hi' },
			nextContext,
		)
		expect(result.result).toEqual({ replaced: true })
	})
})

describe('normalizeSession preserves readVaultPaths (rehydration)', () => {
	it('preserves readVaultPaths through normalizeSession', () => {
		const state = {
			loadedSessions: new Map(),
			sessionIndex: [],
			runtimeBySessionId: new Map(),
			autoApproveRequestsBySessionId: new Map(),
			deletedSessionIds: new Set(),
			chatModalHostEl: null,
		} as unknown as ChatState
		const runtimeStates = new RuntimeStates(state)
		const selection = {
			sanitizeSessionSelection: () => false,
		} as unknown as Selection
		const store = new SessionStore(state, runtimeStates, selection)

		const session: ChatSession = {
			id: 's1',
			createdAt: 0,
			updatedAt: 0,
			fragments: [
				{
					id: 'f1',
					createdAt: 0,
					updatedAt: 0,
					messages: [],
					readVaultPaths: ['notes/a.md', 'notes/b.md'],
				},
			],
			activeFragmentId: 'f1',
			tasks: [],
		}

		const normalized = store.normalizeSession(session)
		expect(normalized.fragments[0].readVaultPaths).toEqual([
			'notes/a.md',
			'notes/b.md',
		])
	})

	it('preserves undefined readVaultPaths through normalizeSession', () => {
		const state = {
			loadedSessions: new Map(),
			sessionIndex: [],
			runtimeBySessionId: new Map(),
			autoApproveRequestsBySessionId: new Map(),
			deletedSessionIds: new Set(),
			chatModalHostEl: null,
		} as unknown as ChatState
		const runtimeStates = new RuntimeStates(state)
		const selection = {
			sanitizeSessionSelection: () => false,
		} as unknown as Selection
		const store = new SessionStore(state, runtimeStates, selection)

		const session: ChatSession = {
			id: 's1',
			createdAt: 0,
			updatedAt: 0,
			fragments: [
				{
					id: 'f1',
					createdAt: 0,
					updatedAt: 0,
					messages: [],
				},
			],
			activeFragmentId: 'f1',
			tasks: [],
		}

		const normalized = store.normalizeSession(session)
		expect(normalized.fragments[0].readVaultPaths).toBeUndefined()
	})
})

describe('bash tool UTF-8 handling', () => {
	it('returns decoded UTF-8 text without project-level re-decoding', async () => {
		const { vault, store } = createMockVaultForExecutor([
			{ path: 'notes/source.md', content: '中文测试\n' },
		])
		const app = { vault } as unknown as App
		const tools = createAITools(app, { permissionGuard: undefined })
		const tool = findTool(tools, 'bash')
		const session = makeSession()

		const result = await tool.execute(
			tool.inputSchema.parse({
				script:
					'cat /vault/notes/source.md > /vault/notes/copy.md && cat /vault/notes/copy.md',
			}),
			makeContext(session),
		)

		expect(result.result).toBe('中文测试\n\n\n')
		expect(store.get('notes/copy.md')).toBe('中文测试\n')
	})
})

describe('ToolExecutor.resolveToolCalls read-gate wiring', () => {
	function makeToolExecutor() {
		const state = {
			loadedSessions: new Map(),
			sessionIndex: [],
			runtimeBySessionId: new Map(),
			autoApproveRequestsBySessionId: new Map(),
			deletedSessionIds: new Set(),
			chatModalHostEl: null,
		} as unknown as ChatState
		const runtimeStates = new RuntimeStates(state)
		const plugin = {} as never
		const executor = new ToolExecutor(plugin, state, runtimeStates)
		return { executor, runtimeStates, state }
	}

	function makeSession(fragment: ChatFragment): ChatSession {
		return {
			id: 's1',
			createdAt: 0,
			updatedAt: 0,
			fragments: [fragment],
			activeFragmentId: fragment.id,
			tasks: [],
		}
	}

	function toolCall(
		toolName: string,
		input: Record<string, unknown>,
	): AIToolCall {
		return {
			type: 'tool-call',
			toolCallId: `call_${toolName}_${Math.random()}`,
			toolName,
			input,
		}
	}

	it('blocks edit_file in the same resolveToolCalls batch as bash cat (race guard at executor level)', async () => {
		const { vault, store } = createMockVaultForExecutor([
			{ path: 'notes/x.md', content: 'hello world' },
		])
		const app = { vault } as unknown as App
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const session = makeSession(fragment)
		const { executor } = makeToolExecutor()
		executor['plugin'] = { app } as never

		const tools = createAITools(app, { permissionGuard: undefined })

		const toolCalls: AIToolCall[] = [
			toolCall('bash', { script: 'cat /vault/notes/x.md' }),
			toolCall('edit_file', {
				path: 'notes/x.md',
				oldText: 'hello',
				newText: 'hi',
			}),
		]

		const results = await executor.resolveToolCalls(toolCalls, tools, {
			session,
			depth: 0,
			maxDepth: 2,
		})

		expect(fragment.readVaultPaths).toEqual(['notes/x.md'])
		const editResult = results.find(
			(r) =>
				r.message.content[0]?.type === 'tool-result' &&
				r.message.content[0].toolName === 'edit_file',
		)
		expect(editResult?.isError).toBe(true)
		expect(store.get('notes/x.md')).toBe('hello world')
	})

	it('allows edit_file in a subsequent resolveToolCalls batch after bash cat in a prior batch', async () => {
		const { vault, store } = createMockVaultForExecutor([
			{ path: 'notes/x.md', content: 'hello world' },
		])
		const app = { vault } as unknown as App
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const session = makeSession(fragment)
		const { executor } = makeToolExecutor()
		executor['plugin'] = { app } as never

		const tools = createAITools(app, { permissionGuard: undefined })

		const batch1Results = await executor.resolveToolCalls(
			[toolCall('bash', { script: 'cat /vault/notes/x.md' })],
			tools,
			{ session, depth: 0, maxDepth: 2 },
		)
		expect(batch1Results[0].isError).toBe(false)
		expect(fragment.readVaultPaths).toEqual(['notes/x.md'])

		const batch2Results = await executor.resolveToolCalls(
			[
				toolCall('edit_file', {
					path: 'notes/x.md',
					oldText: 'hello',
					newText: 'hi',
				}),
			],
			tools,
			{ session, depth: 0, maxDepth: 2 },
		)
		expect(batch2Results[0].isError).toBe(false)
		expect(store.get('notes/x.md')).toBe('hi world')
	})
})
