import type { ToolCallPart, ToolSet } from 'ai'
import { describe, expect, it } from 'vitest'
import { TFile, TFolder, type App, type Vault } from 'obsidian'
import { InMemoryFs, type IFileSystem } from 'just-bash/browser'
import { createAITools } from '~/ai/tools/tools'
import i18n from '~/i18n'
import { createFragmentReadTracker } from '~/ai/tools/file-operation'
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
	const { vault, store } = createMockVaultForExecutor(files)
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
		async delete(file: { path: string }) {
			store.delete(file.path)
		},
		async rename(file: { path: string }, path: string) {
			const content = store.get(file.path)
			if (content === undefined) throw new Error(`missing: ${file.path}`)
			store.delete(file.path)
			store.set(path, content)
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
	app: App,
	session: ChatSession,
	extra: Record<string, unknown> = {},
) {
	return { app, session, agentId: 'master', ...extra }
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

async function callApplyPatch(patch: string, context: unknown) {
	const tool = findTool(createAITools(), 'apply_patch')
	return executeToolForTest(tool, { patch }, context)
}

async function executeToolForTest(
	tool: ToolSet[string],
	input: unknown,
	context: unknown,
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
		expect('use_skill' in createAITools()).toBe(false)
	})

	it('registers only the asynchronous task dispatch tool for subagents', async () => {
		const dispatched: unknown[] = []
		const tools = createAITools()
		const tool = findTool(tools, 'task')
		const session = makeSession()
		const context = {
			session,
			agentId: 'caller-agent',
			dispatchTask: async (params: unknown) => {
				dispatched.push(params)
				return {
					taskId: 'task-example',
					subagentType: EXPLORER_AGENT_ID,
					status: 'dispatched' as const,
				}
			},
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

describe('apply_patch read-gate', () => {
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

		const result = await callApplyPatch(
			[
				'*** Begin Patch',
				'*** Update File: vault/notes/x.md',
				'@@',
				'-nested target',
				'+updated target',
				'*** End Patch',
			].join('\n'),
			makeContext(app, session, {
				readTracker: createFragmentReadTracker(fragment),
			}),
		)

		expect(result).toEqual({
			applied: true,
			files: ['vault/notes/x.md'],
		})
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
		const context = makeContext(app, session, { readTracker: tracker })

		await expect(
			callApplyPatch(
				[
					'*** Begin Patch',
					'*** Update File: notes/x.md',
					'@@',
					'-hello world',
					'+hi world',
					'*** End Patch',
				].join('\n'),
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
		const context = makeContext(app, session, { readTracker: batch2Tracker })

		const result = await callApplyPatch(
			[
				'*** Begin Patch',
				'*** Update File: notes/x.md',
				'@@',
				'-hello world',
				'+hi world',
				'*** End Patch',
			].join('\n'),
			context,
		)

		expect(result).toEqual({ applied: true, files: ['notes/x.md'] })
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
		const context = makeContext(app, session, { readTracker: batch2Tracker })

		const result = await callApplyPatch(
			[
				'*** Begin Patch',
				'*** Update File: /vault/notes/x.md',
				'@@',
				'-hello world',
				'+hi world',
				'*** End Patch',
			].join('\n'),
			context,
		)

		expect(result).toEqual({ applied: true, files: ['notes/x.md'] })
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
		const context = makeContext(app, session, { readTracker: tracker })

		await expect(
			callApplyPatch(
				[
					'*** Begin Patch',
					'*** Update File: notes/x.md',
					'@@',
					'-hello world',
					'+hi world',
					'*** End Patch',
				].join('\n'),
				context,
			),
		).rejects.toThrow(/read .*notes\/x\.md/i)
	})

	it('fails closed (blocks) when readTracker is undefined', async () => {
		const { app } = createMockApp([
			{ path: 'notes/x.md', content: 'hello world' },
		])
		const session = makeSession()
		const context = makeContext(app, session)

		await expect(
			callApplyPatch(
				[
					'*** Begin Patch',
					'*** Update File: notes/x.md',
					'@@',
					'-hello world',
					'+hi world',
					'*** End Patch',
				].join('\n'),
				context,
			),
		).rejects.toThrow(/read .*notes\/x\.md/i)
	})

	it('blocks apply_patch when bash cat shares the same batch tracker', async () => {
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
		const context = makeContext(app, session, { readTracker: sharedTracker })

		await expect(
			callApplyPatch(
				[
					'*** Begin Patch',
					'*** Update File: notes/x.md',
					'@@',
					'-hello world',
					'+hi world',
					'*** End Patch',
				].join('\n'),
				context,
			),
		).rejects.toThrow(/read .*notes\/x\.md/i)

		expect(fragment.readVaultPaths).toEqual(['notes/x.md'])

		sharedTracker.resetSnapshot()
		const result = await callApplyPatch(
			[
				'*** Begin Patch',
				'*** Update File: notes/x.md',
				'@@',
				'-hello world',
				'+hi world',
				'*** End Patch',
			].join('\n'),
			context,
		)
		expect(result).toEqual({ applied: true, files: ['notes/x.md'] })
	})
})

describe('apply_patch file operations', () => {
	it('rejects a file header without the Codex colon syntax', async () => {
		const { app } = createMockApp([
			{
				path: '示例/协作记录.md',
				content:
					'<<<<<<< 本地版本\n本地内容\n=======\n远端内容\n>>>>>>> 远端版本\n',
			},
		])
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const previousBatch = createFragmentReadTracker(fragment)
		previousBatch.markRead('示例/协作记录.md')

		await expect(
			callApplyPatch(
				[
					'*** Begin Patch',
					'*** Update File /vault/示例/协作记录.md',
					'@@',
					'-本地内容',
					'+合并内容',
					'*** End Patch',
				].join('\n'),
				makeContext(app, makeSession(fragment), {
					readTracker: createFragmentReadTracker(fragment),
				}),
			),
		).rejects.toThrow(
			'Invalid patch: unexpected line "*** Update File /vault/示例/协作记录.md"',
		)
	})

	it('accepts unified numeric hunk headers when resolving Chinese conflicts', async () => {
		const { app, store } = createMockApp([
			{
				path: 'notes/conflict.md',
				content: [
					'# 协作记录',
					'',
					'## 安排',
					'',
					'<<<<<<< 本地版本',
					'Local schedule',
					'=======',
					'远端安排',
					'>>>>>>> 远端版本',
					'',
					'## 结论',
					'',
				].join('\n'),
			},
		])
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const previousBatch = createFragmentReadTracker(fragment)
		previousBatch.markRead('notes/conflict.md')

		const result = await callApplyPatch(
			[
				'*** Begin Patch',
				'*** Update File: notes/conflict.md',
				'@@ -20,9 +20,5 @@',
				' ## 安排',
				' ',
				'-<<<<<<< 本地版本',
				' Local schedule',
				'-=======',
				'-远端安排',
				'->>>>>>> 远端版本',
				' ',
				' ## 结论',
				'*** End Patch',
			].join('\n'),
			makeContext(app, makeSession(fragment), {
				readTracker: createFragmentReadTracker(fragment),
			}),
		)

		expect(result).toEqual({
			applied: true,
			files: ['notes/conflict.md'],
		})
		expect(store.get('notes/conflict.md')).toBe(
			'# 协作记录\n\n## 安排\n\nLocal schedule\n\n## 结论\n',
		)
	})

	it('applies bilingual multi-hunk updates, moves, additions, and deletions', async () => {
		const { app, store } = createMockApp([
			{
				path: 'notes/source.md',
				content: 'English line\n中性内容\n中文行\nEnding line\n',
			},
			{ path: 'notes/remove.md', content: 'Temporary note\n临时笔记\n' },
		])
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const previousBatch = createFragmentReadTracker(fragment)
		previousBatch.markRead('notes/source.md')
		previousBatch.markRead('notes/remove.md')
		const metadata: unknown[] = []

		const result = await callApplyPatch(
			[
				'*** Begin Patch',
				'*** Update File: notes/source.md',
				'*** Move to: archive/source.md',
				'@@',
				'-English line',
				'+Updated line',
				' 中性内容',
				'@@',
				'-中文行',
				'+更新行',
				' Ending line',
				'*** Add File: notes/new.md',
				'+Sample note',
				'+示例笔记',
				'*** Delete File: notes/remove.md',
				'*** End Patch',
			].join('\n'),
			makeContext(app, makeSession(fragment), {
				readTracker: createFragmentReadTracker(fragment),
				recordMetadata: (_toolCallId: string, value: unknown) => {
					metadata.push(value)
				},
			}),
		)

		expect(result).toEqual({
			applied: true,
			files: [
				'notes/source.md',
				'archive/source.md',
				'notes/new.md',
				'notes/remove.md',
			],
		})
		expect(store.has('notes/source.md')).toBe(false)
		expect(store.get('archive/source.md')).toBe(
			'Updated line\n中性内容\n更新行\nEnding line\n',
		)
		expect(store.get('notes/new.md')).toBe('Sample note\n示例笔记\n')
		expect(store.has('notes/remove.md')).toBe(false)
		expect(metadata).toHaveLength(1)
	})

	it('does not write any file when a later bilingual hunk fails validation', async () => {
		const { app, store } = createMockApp([
			{ path: 'notes/first.md', content: 'First line\n第一行\n' },
			{ path: 'notes/second.md', content: 'Second line\n第二行\n' },
		])
		const fragment: ChatFragment = {
			id: 'f1',
			createdAt: 0,
			updatedAt: 0,
			messages: [],
		}
		const previousBatch = createFragmentReadTracker(fragment)
		previousBatch.markRead('notes/first.md')
		previousBatch.markRead('notes/second.md')

		await expect(
			callApplyPatch(
				[
					'*** Begin Patch',
					'*** Update File: notes/first.md',
					'@@',
					'-First line',
					'+Updated line',
					' 第一行',
					'*** Update File: notes/second.md',
					'@@',
					'-Missing line',
					'+缺失行',
					'*** End Patch',
				].join('\n'),
				makeContext(app, makeSession(fragment), {
					readTracker: createFragmentReadTracker(fragment),
				}),
			),
		).rejects.toThrow(/hunk context was not found/)

		expect(store.get('notes/first.md')).toBe('First line\n第一行\n')
		expect(store.get('notes/second.md')).toBe('Second line\n第二行\n')
	})
})

describe('update_session_title tool', () => {
	it('records the proposed title via recordMetadata and echoes it back', async () => {
		const tools = createAITools()
		const tool = findTool(tools, 'update_session_title')
		const recorded: Array<{ toolCallId: string; metadata: unknown }> = []
		const context = {
			recordMetadata: (toolCallId: string, metadata: unknown) => {
				recorded.push({ toolCallId, metadata })
			},
		}

		const output = await executeToolForTest(
			tool,
			{ title: 'Refactor vault sync' },
			context,
		)

		expect(output).toEqual({ updated: true, title: 'Refactor vault sync' })
		expect(recorded).toEqual([
			{
				toolCallId: 'test-tool-call',
				metadata: { sessionTitle: 'Refactor vault sync' },
			},
		])
	})

	it('trims surrounding whitespace before recording the title', async () => {
		const tools = createAITools()
		const tool = findTool(tools, 'update_session_title')
		const recorded: string[] = []
		const context = {
			recordMetadata: (_id: string, metadata: { sessionTitle?: string }) => {
				recorded.push(metadata.sessionTitle ?? '')
			},
		}

		const output = await executeToolForTest(
			tool,
			{ title: '  padded title  ' },
			context,
		)

		expect(output).toEqual({ updated: true, title: 'padded title' })
		expect(recorded).toEqual(['padded title'])
	})

	it('produces a concise model-facing output', async () => {
		const tools = createAITools()
		const tool = findTool(tools, 'update_session_title')
		const context = {}

		const output = await executeToolForTest(
			tool,
			{ title: 'Plan weekly review' },
			context,
		)

		expect(
			await tool.toModelOutput?.({
				toolCallId: 'tc',
				input: { title: 'Plan weekly review' },
				output,
			}),
		).toEqual({
			type: 'text',
			value: 'Session title updated to "Plan weekly review".',
		})
	})
})

describe('note_neighborhood path resolution', () => {
	it('rejects a folder path with a clear error', async () => {
		const folder = Object.assign(new TFolder(), {
			path: 'projects',
			name: 'projects',
			children: [],
		})
		const app = {
			vault: {
				getAbstractFileByPath: (path: string) =>
					path === folder.path ? folder : null,
			},
			metadataCache: {
				getFirstLinkpathDest: () => null,
			},
		} as unknown as App
		const tool = findTool(createAITools(), 'note_neighborhood')

		await expect(
			executeToolForTest(
				tool,
				{ note: folder.path, depth: 1 },
				makeContext(app, makeSession()),
			),
		).rejects.toThrow(i18n.t('chatbox.errors.notFile', { path: folder.path }))
	})

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
		const tool = findTool(createAITools(), 'note_neighborhood')

		const result = await executeToolForTest(
			tool,
			{ note: 'Shared', depth: 1 },
			makeContext(app, makeSession(fragment)),
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
		const tools = createAITools()
		const tool = findTool(tools, 'bash')
		const session = makeSession()

		const result = await executeToolForTest(
			tool,
			{
				script:
					'cat /vault/notes/source.md > /vault/notes/copy.md && cat /vault/notes/copy.md',
			},
			makeContext(app, session, { scratch: new InMemoryFs() }),
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
		const tool = findTool(createAITools(), 'bash')
		const session = makeSession()

		const scratch = new InMemoryFs()
		const result = await executeToolForTest(
			tool,
			{ script: 'cat /vault/notes/large.md' },
			makeContext(app, session, { scratch }),
		)

		expect(result).toEqual(expect.stringContaining('too long'))
		const outputPath = String(result).match(/\/tmp\/bash_[^\s]+\.txt/)?.[0]
		expect(outputPath).toBeDefined()

		const readBack = await executeToolForTest(
			tool,
			{ script: `wc -c ${outputPath}` },
			makeContext(app, session, { scratch }),
		)
		expect(readBack).toEqual(
			expect.stringContaining(String(content.length + 2)),
		)
	})
})

describe('ToolExecutor SDK tool-round read-gate wiring', () => {
	function makeToolExecutor(app = {} as App) {
		const state = {
			loadedSessions: new Map(),
			sessionIndex: [],
			runtimeBySessionId: new Map(),
			autoApproveRequestsBySessionId: new Map(),
			deletedSessionIds: new Set(),
			chatModalHostEl: null,
		} as unknown as ChatState
		const runtimeStates = new RuntimeStates(state)
		const executor = new ToolExecutor(
			app,
			() => ({ yolo: false }) as never,
			state,
			runtimeStates,
		)
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
		app: App,
		scratch: IFileSystem,
		toolCalls: ToolCallPart[],
		tools: ToolSet,
		session: ChatSession,
	) {
		const readTracker = executor.prepareReadTracker(session, 'master')
		const context = makeContext(app, session, { readTracker, scratch })
		return Promise.allSettled(
			toolCalls.map((call) => {
				const tool = tools[call.toolName]
				if (!tool) throw new Error(`Missing tool: ${call.toolName}`)
				return executeToolForTest(tool, call.input, context)
			}),
		)
	}

	it('blocks apply_patch in the same SDK tool round as bash cat', async () => {
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
		const { executor } = makeToolExecutor(app)

		const tools = createAITools()
		const scratch = new InMemoryFs()

		const toolCalls: ToolCallPart[] = [
			toolCall('bash', { script: 'cat /vault/notes/x.md' }),
			toolCall('apply_patch', {
				patch: [
					'*** Begin Patch',
					'*** Update File: notes/x.md',
					'@@',
					'-hello world',
					'+hi world',
					'*** End Patch',
				].join('\n'),
			}),
		]

		const results = await executeRound(
			executor,
			app,
			scratch,
			toolCalls,
			tools,
			session,
		)

		expect(session.subagents.master.readVaultPaths).toEqual(['notes/x.md'])
		const editResult = results[1]
		expect(editResult?.status).toBe('rejected')
		expect(store.get('notes/x.md')).toBe('hello world')
	})

	it('allows apply_patch in the SDK round after bash cat', async () => {
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
		const { executor } = makeToolExecutor(app)

		const tools = createAITools()
		const scratch = new InMemoryFs()

		const batch1Results = await executeRound(
			executor,
			app,
			scratch,
			[toolCall('bash', { script: 'cat /vault/notes/x.md' })],
			tools,
			session,
		)
		expect(batch1Results[0].status).toBe('fulfilled')
		expect(session.subagents.master.readVaultPaths).toEqual(['notes/x.md'])

		const batch2Results = await executeRound(
			executor,
			app,
			scratch,
			[
				toolCall('apply_patch', {
					patch: [
						'*** Begin Patch',
						'*** Update File: notes/x.md',
						'@@',
						'-hello world',
						'+hi world',
						'*** End Patch',
					].join('\n'),
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
			plugin.app as never,
			() => plugin.settings.ai as never,
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
		const tools = executor.createTools(1, definition)
		const bash = findTool(tools, 'bash')
		const stable = executor.createStableToolsContext(session, definition)

		await expect(
			executeToolForTest(
				bash,
				{
					script: "printf 'after' > /vault/notes/x.md",
				},
				{
					app: stable.app,
					permissionGuard: stable.permissionGuard,
					scratch: stable.scratch,
					session,
					agentId: explorer.id,
				},
			),
		).rejects.toThrow('read-only')
		expect(store.get('notes/x.md')).toBe('before')
	})
})

describe('filterToolsForAgent', () => {
	it('excludes apply_patch, todowrite, and update_session_title for the explorer subagent', () => {
		const tools = createAITools({ allowSpawn: true })
		const definition = getAgentDefinition(EXPLORER_AGENT_ID)
		if (!definition) throw new Error('Expected explorer agent definition')
		const filtered = filterToolsForAgent(tools, definition)
		const names = Object.keys(filtered)

		expect(names).not.toContain('apply_patch')
		expect(names).not.toContain('todowrite')
		expect(names).not.toContain('update_session_title')
		expect(names).toContain('bash')
		expect(names).toContain('note_neighborhood')
		expect(names).toContain('task')
	})

	it('returns all tools for the master agent type', () => {
		const tools = createAITools({ enableTodoWrite: true, allowSpawn: true })
		const definition = getAgentDefinition('master')
		if (!definition) throw new Error('Expected master agent definition')
		const filtered = filterToolsForAgent(tools, definition)
		const names = Object.keys(filtered)

		expect(names).toContain('apply_patch')
		expect(names).toContain('bash')
		expect(names).toContain('note_neighborhood')
		expect(names).toContain('todowrite')
		expect(names).toContain('update_session_title')
		expect(names).toContain('task')
	})
})
