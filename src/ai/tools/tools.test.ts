import type { ToolCallPart, ToolSet } from 'ai'
import { describe, expect, it } from 'vitest'
import { TFile, TFolder, type App, type Vault } from 'obsidian'
import { createAITools } from '~/ai/tools/tools'
import {
	createFragmentReadTracker,
	type ReadTracker,
} from '~/ai/tools/file-operation'
import type { AppToolContext } from '~/ai/core/types'
import type { ChatFragment, ChatSession } from '~/ai/chat/domain'
import { ToolExecutor } from '~/ai/chat/runtime/tool-executor'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import type { Selection } from '~/ai/chat/runtime/selection'
import { SessionStore } from '~/ai/chat/session/session-store'
import { migrateLegacySession } from '~/ai/chat/session/session-migration'
import { createEmptyMasterAgent } from '~/ai/chat/messages/ui-message'
import {
	EXPLORER_AGENT_ID,
	filterToolsForAgent,
	getAgentDefinition,
	MASTER_AGENT_ID,
} from '~/ai/chat/agents/registry'

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

function findTool(tools: ToolSet, name: string) {
	const tool = tools[name]
	if (!tool) throw new Error(`tool not found: ${name}`)
	return tool
}

function makeContext(
	session: ChatSession,
	readTracker?: ReadTracker,
): AppToolContext {
	return {
		session,
		agentId: 'master',
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
	return migrateLegacySession({
		id: 's1',
		createdAt: 0,
		updatedAt: 0,
		fragments: [frag],
		activeFragmentId: frag.id,
	})
}

async function callEditFile(
	app: App,
	params: { path: string; oldText: string; newText: string },
	context: AppToolContext,
) {
	const tools = createAITools(app, { permissionGuard: undefined })
	const tool = findTool(tools, 'edit_file')
	return executeToolForTest(tool, params, context)
}

async function executeToolForTest(
	tool: ToolSet[string],
	input: unknown,
	context: AppToolContext,
): Promise<unknown> {
	if (!tool.execute) throw new Error('Expected executable tool')
	return (await tool.execute(input, {
		toolCallId: 'test-tool-call',
		messages: [],
		context,
	})) as unknown
}

describe('tool registration', () => {
	it('does not register a dedicated use_skill tool', () => {
		expect('use_skill' in createAITools({} as never)).toBe(false)
	})

	it('registers only the asynchronous task dispatch tool for subagents', async () => {
		const dispatched: unknown[] = []
		const tools = createAITools({} as never, {
			dispatchTask: async (params) => {
				dispatched.push(params)
				return {
					taskId: 'task-example',
					subagentType: EXPLORER_AGENT_ID,
					status: 'dispatched',
				}
			},
		})
		const tool = findTool(tools, 'task')
		const session = makeSession()
		const context: AppToolContext = {
			session,
			agentId: 'caller-agent',
		}

		const output = await executeToolForTest(
			tool,
			{
				subagent_type: EXPLORER_AGENT_ID,
				prompt: 'Inspect the vault',
			},
			context,
		)

		expect('spawn' in tools).toBe(false)
		expect('background_output' in tools).toBe(false)
		expect(dispatched).toEqual([
			{
				prompt: 'Inspect the vault',
				subagentType: EXPLORER_AGENT_ID,
				callerAgentId: 'caller-agent',
				sessionId: session.id,
			},
		])
		expect(output).toEqual({
			taskId: 'task-example',
			subagentType: EXPLORER_AGENT_ID,
			status: 'dispatched',
		})
		expect(
			await tool.toModelOutput?.({
				toolCallId: 'task-call',
				input: {
					subagent_type: EXPLORER_AGENT_ID,
					prompt: 'Inspect the vault',
				},
				output,
			}),
		).toEqual({
			type: 'text',
			value: expect.stringContaining('Task dispatched. Task ID: task-example.'),
		})
	})
})

describe('edit_file read-gate', () => {
	it('treats a vault/ prefix without a leading slash as a vault-relative folder', async () => {
		const { app, store } = createMockApp([
			{ path: 'vault/notes/x.md', content: 'nested target' },
			{ path: 'notes/x.md', content: 'root target' },
		])
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const session = makeSession(fragment)
		const previousBatch = createFragmentReadTracker(fragment)
		previousBatch.markRead('vault/notes/x.md')

		const result = await callEditFile(
			app,
			{
				path: 'vault/notes/x.md',
				oldText: 'nested',
				newText: 'updated',
			},
			makeContext(session, createFragmentReadTracker(fragment)),
		)

		expect(result).toEqual({ replaced: true })
		expect(store.get('vault/notes/x.md')).toBe('updated target')
		expect(store.get('notes/x.md')).toBe('root target')
	})

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

		expect(result).toEqual({ replaced: true })
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

		expect(result).toEqual({ replaced: true })
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
		const session = migrateLegacySession({
			id: 's1',
			createdAt: 0,
			updatedAt: 0,
			fragments: [oldFragment, newFragment],
			activeFragmentId: 'f2',
		})
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
		expect(result).toEqual({ replaced: true })
	})
})

describe('note_neighborhood path resolution', () => {
	it('resolves an ambiguous link path relative to the current note', async () => {
		const { app } = createMockApp([
			{ path: 'projects/a/Shared.md', content: 'A' },
			{ path: 'projects/b/Current.md', content: 'current' },
			{ path: 'projects/b/Shared.md', content: 'B' },
		])
		app.metadataCache = {
			resolvedLinks: {},
			getFirstLinkpathDest(linkpath: string, sourcePath: string) {
				if (linkpath !== 'Shared') return null
				return app.vault.getAbstractFileByPath(
					sourcePath.startsWith('projects/b/')
						? 'projects/b/Shared.md'
						: 'projects/a/Shared.md',
				) as TFile | null
			},
		} as App['metadataCache']
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [
				{
					id: 'm1',
					createdAt: 0,
					message: {
						role: 'user',
						content: [{ type: 'text', text: 'Show the neighborhood.' }],
					},
					workspaceContextDelta: [
						{
							key: 'activeFile',
							content: 'projects/b/Current.md',
							hash: 'active-file-hash',
						},
					],
				},
			],
		}
		const tool = findTool(createAITools(app), 'note_neighborhood')

		const result = await executeToolForTest(
			tool,
			{ note: 'Shared', depth: 1 },
			makeContext(makeSession(fragment)),
		)

		expect(result).toMatchObject({ root: 'projects/b/Shared.md' })
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

		const master = createEmptyMasterAgent(0)
		master.readVaultPaths = ['notes/a.md', 'notes/b.md']
		const session: ChatSession = {
			schemaVersion: 2,
			id: 's1',
			createdAt: 0,
			updatedAt: 0,
			subagents: { master },
		}

		const normalized = store.normalizeSession(session)
		expect(normalized.subagents.master.readVaultPaths).toEqual([
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
			schemaVersion: 2,
			id: 's1',
			createdAt: 0,
			updatedAt: 0,
			subagents: { master: createEmptyMasterAgent(0) },
		}

		const normalized = store.normalizeSession(session)
		expect(normalized.subagents.master.readVaultPaths).toBeUndefined()
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

		const result = await executeToolForTest(
			tool,
			{
				script:
					'cat /vault/notes/source.md > /vault/notes/copy.md && cat /vault/notes/copy.md',
			},
			makeContext(session),
		)

		expect(result).toBe('中文测试\n\n\n')
		expect(store.get('notes/copy.md')).toBe('中文测试\n')
	})

	it('writes oversized output to a readable temporary file', async () => {
		const content = 'x'.repeat(25 * 1024)
		const { vault } = createMockVaultForExecutor([
			{ path: 'notes/large.md', content },
		])
		const app = { vault } as unknown as App
		const tool = findTool(createAITools(app), 'bash')
		const session = makeSession()

		const result = await executeToolForTest(
			tool,
			{ script: 'cat /vault/notes/large.md' },
			makeContext(session),
		)

		expect(result).toEqual(expect.stringContaining('too long'))
		const outputPath = String(result).match(/\/tmp\/bash_[^\s]+\.txt/)?.[0]
		expect(outputPath).toBeDefined()

		const readBack = await executeToolForTest(
			tool,
			{ script: `wc -c ${outputPath}` },
			makeContext(session),
		)
		expect(readBack).toEqual(
			expect.stringContaining(String(content.length + 2)),
		)
	})
})

describe('ToolExecutor SDK tool-round read-gate wiring', () => {
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
		return migrateLegacySession({
			id: 's1',
			createdAt: 0,
			updatedAt: 0,
			fragments: [fragment],
			activeFragmentId: fragment.id,
		})
	}

	function toolCall(
		toolName: string,
		input: Record<string, unknown>,
	): ToolCallPart {
		return {
			type: 'tool-call',
			toolCallId: `call_${toolName}_${Math.random()}`,
			toolName,
			input,
		}
	}

	async function executeRound(
		executor: ToolExecutor,
		toolCalls: ToolCallPart[],
		tools: ReturnType<typeof createAITools>,
		session: ChatSession,
	) {
		const context = executor.prepareExecutionContext({
			session,
			agentId: 'master',
		})
		return Promise.allSettled(
			toolCalls.map((call) => {
				const tool = tools[call.toolName]
				if (!tool) throw new Error(`Missing tool: ${call.toolName}`)
				return executeToolForTest(tool, call.input, context)
			}),
		)
	}

	it('blocks edit_file in the same SDK tool round as bash cat', async () => {
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

		const toolCalls: ToolCallPart[] = [
			toolCall('bash', { script: 'cat /vault/notes/x.md' }),
			toolCall('edit_file', {
				path: 'notes/x.md',
				oldText: 'hello',
				newText: 'hi',
			}),
		]

		const results = await executeRound(executor, toolCalls, tools, session)

		expect(session.subagents.master.readVaultPaths).toEqual(['notes/x.md'])
		const editResult = results[1]
		expect(editResult?.status).toBe('rejected')
		expect(store.get('notes/x.md')).toBe('hello world')
	})

	it('allows edit_file in the SDK round after bash cat', async () => {
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

		const batch1Results = await executeRound(
			executor,
			[toolCall('bash', { script: 'cat /vault/notes/x.md' })],
			tools,
			session,
		)
		expect(batch1Results[0].status).toBe('fulfilled')
		expect(session.subagents.master.readVaultPaths).toEqual(['notes/x.md'])

		const batch2Results = await executeRound(
			executor,
			[
				toolCall('edit_file', {
					path: 'notes/x.md',
					oldText: 'hello',
					newText: 'hi',
				}),
			],
			tools,
			session,
		)
		expect(batch2Results[0].status).toBe('fulfilled')
		expect(store.get('notes/x.md')).toBe('hi world')
	})

	it('keeps explorer read-only when global full access is enabled', async () => {
		const { vault, store } = createMockVaultForExecutor([
			{ path: 'notes/x.md', content: 'before' },
		])
		const session = makeSession({
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		})
		const explorer = {
			...createEmptyMasterAgent(0),
			id: 'explorer-test',
			type: EXPLORER_AGENT_ID,
			status: 'running' as const,
		}
		session.subagents.master.subagents[explorer.id] = explorer
		const state = {
			loadedSessions: new Map([[session.id, session]]),
			sessionIndex: [],
			runtimeBySessionId: new Map(),
			autoApproveRequestsBySessionId: new Map(),
			deletedSessionIds: new Set(),
			chatModalHostEl: null,
		} as unknown as ChatState
		const plugin = {
			app: { vault },
			settings: { ai: { yolo: true } },
		}
		const executor = new ToolExecutor(
			plugin as never,
			state,
			new RuntimeStates(state),
		)
		expect(executor.getAgentDefinition(MASTER_AGENT_ID).permissionMode).toBe(
			'full',
		)
		plugin.settings.ai.yolo = false
		expect(executor.getAgentDefinition(MASTER_AGENT_ID).permissionMode).toBe(
			'ask',
		)
		plugin.settings.ai.yolo = true
		const definition = executor.getAgentDefinition(EXPLORER_AGENT_ID)
		const tools = executor.createToolsForContext(session, 1, definition)
		const bash = findTool(tools, 'bash')

		await expect(
			executeToolForTest(
				bash,
				{
					script: "printf 'after' > /vault/notes/x.md",
				},
				{
					session,
					agentId: explorer.id,
				},
			),
		).rejects.toThrow('read-only')
		expect(store.get('notes/x.md')).toBe('before')
	})
})

describe('filterToolsForAgent', () => {
	it('excludes edit_file and todowrite for the explorer subagent', () => {
		const tools = createAITools({} as never, {
			dispatchTask: async () => ({
				taskId: 't',
				subagentType: EXPLORER_AGENT_ID,
				status: 'dispatched',
			}),
		})
		const definition = getAgentDefinition(EXPLORER_AGENT_ID)
		if (!definition) throw new Error('Expected explorer agent definition')
		const filtered = filterToolsForAgent(tools, definition)
		const names = Object.keys(filtered)

		expect(names).not.toContain('edit_file')
		expect(names).not.toContain('todowrite')
		expect(names).toContain('bash')
		expect(names).toContain('note_neighborhood')
		expect(names).toContain('task')
	})

	it('returns all tools for the master agent type', () => {
		const tools = createAITools({} as never, {
			enableTodoWrite: true,
			dispatchTask: async () => ({
				taskId: 't',
				subagentType: EXPLORER_AGENT_ID,
				status: 'dispatched',
			}),
		})
		const definition = getAgentDefinition('master')
		if (!definition) throw new Error('Expected master agent definition')
		const filtered = filterToolsForAgent(tools, definition)
		const names = Object.keys(filtered)

		expect(names).toContain('edit_file')
		expect(names).toContain('bash')
		expect(names).toContain('note_neighborhood')
		expect(names).toContain('todowrite')
		expect(names).toContain('task')
	})
})
