import { afterEach, describe, expect, it, vi } from 'vitest'
import type NutstorePlugin from '~/index'
import { ModuleScope } from '~/modules/lifecycle'
import type { McpServerConfig } from '~/ai/mcp/types'
import McpService from './mcp.service'
import { formatMcpToolResult } from '~/ai/mcp/result-artifact'
import { z } from 'zod/mini'
import {
	createAgentDefinitions,
	filterToolsForAgent,
} from '~/ai/chat/agents/registry'

const { clients } = vi.hoisted(() => ({
	clients: [] as Array<{
		url: string
		resolve: (value: {
			tools: Array<{
				name: string
				description: string
				inputSchema?: Record<string, unknown>
			}>
		}) => void
		reject: (error: Error) => void
		close: ReturnType<typeof vi.fn>
		call: ReturnType<typeof vi.fn>
	}>,
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
	Client: class {
		private entry?: (typeof clients)[number]
		private result = new Promise<{
			tools: Array<{
				name: string
				description: string
				inputSchema?: Record<string, unknown>
			}>
		}>((resolve, reject) => {
			this.entry = {
				url: '',
				resolve,
				reject,
				close: vi.fn(async () => {}),
				call: vi.fn(async () => ({
					content: [{ type: 'text', text: 'Notes 笔记 📝' }],
				})),
			}
		})
		async connect(transport: { url: URL }) {
			this.entry!.url = transport.url.href
			clients.push(this.entry!)
		}
		getServerVersion() {
			return {
				name: 'neutral-service',
				version: '1.0.0',
				description: 'Search notes · 搜索笔记 📝',
			}
		}
		getInstructions() {
			return undefined
		}
		callTool(...args: unknown[]) {
			return this.entry!.call(...args)
		}
		listTools() {
			return this.result
		}
		async close() {
			await this.entry!.close()
		}
	},
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
	StreamableHTTPClientTransport: class {
		constructor(readonly url: URL) {}
	},
}))
vi.mock('~/ai/mcp/result-artifact', () => ({
	formatMcpToolResult: vi.fn(
		async (_app: unknown, options: { result: unknown }) =>
			JSON.stringify(options.result),
	),
}))
vi.mock('~/ai/transport/obsidian-fetch', () => ({ obsidianFetch: vi.fn() }))
vi.mock('~/utils/mkdirs-vault', () => ({ mkdirsVault: vi.fn(async () => {}) }))
vi.mock('~/utils/logger', () => ({ default: { warn: vi.fn() } }))

const fixtures: Array<{ scope: ModuleScope; service: McpService }> = []
afterEach(async () => {
	for (const { scope, service } of fixtures.splice(0)) {
		scope.close()
		await service.close()
		await scope.settle()
	}
	clients.length = 0
})

function fixture() {
	let text = '{"mcpServers":{}}'
	let mtime = 1
	const adapter = {
		exists: vi.fn(async () => true),
		read: vi.fn(async () => text),
		stat: vi.fn(async () => ({ mtime })),
		write: vi.fn(async (_path: string, value: string) => {
			text = value
			mtime++
		}),
	}
	const plugin = {
		app: { vault: { adapter }, fileManager: {} },
		manifest: { version: '1.0.0' },
	} as unknown as NutstorePlugin
	const scope = new ModuleScope()
	const service = new McpService(plugin, scope)
	fixtures.push({ scope, service })
	return { scope, service, adapter }
}

const config = (path: string): McpServerConfig => ({
	type: 'http',
	url: `https://example.invalid/${path}`,
	headers: { 'X-Context': 'Notes 笔记 📝' },
})
const tools = {
	tools: [
		{ name: 'read_notes', description: 'Read neutral notes · 阅读中性笔记 📝' },
	],
}

describe('MCP background discovery', () => {
	it('saves and adds another server while the first tool list is still pending', async () => {
		const { service } = fixture()
		await service.saveServers({ alpha: config('alpha') })
		expect(service.getServers()).toHaveProperty('alpha')
		expect(service.getServerRuntimes()[0].status).toBe('connecting')
		await service.saveServers((current) => ({
			...current,
			beta: config('beta'),
		}))
		expect(clients).toHaveLength(2)
		clients[1].resolve(tools)
		await vi.waitFor(() =>
			expect(service.getServerRuntimes()[1].status).toBe('connected'),
		)
		expect(service.getServerRuntimes()[0].status).toBe('connecting')
		expect(service.getServerRuntimes()[1].tools[0].description).toBe(
			tools.tools[0].description,
		)
		clients[0].resolve(tools)
		await vi.waitFor(() =>
			expect(
				service
					.getServerRuntimes()
					.some((runtime) => runtime.status === 'connecting'),
			).toBe(false),
		)
		expect(
			Object.keys(service.getToolsForSession('neutral-session')),
		).toHaveLength(3)
	})

	it('serializes concurrent config mutations without losing either addition', async () => {
		const { service, adapter } = fixture()
		await Promise.all([
			service.saveServers((current) => ({
				...current,
				alpha: config('alpha'),
			})),
			service.saveServers((current) => ({ ...current, beta: config('beta') })),
		])
		expect(Object.keys(service.getServers())).toEqual(['alpha', 'beta'])
		expect(
			JSON.parse(adapter.write.mock.calls.at(-1)![1]).mcpServers.beta.headers[
				'X-Context'
			],
		).toBe('Notes 笔记 📝')
	})

	it('discards an old discovery after removing and re-adding the same endpoint', async () => {
		const { service } = fixture()
		await service.saveServers({ alpha: config('alpha') })
		const old = clients[0]
		await service.saveServers({})
		await service.saveServers({ alpha: config('alpha') })
		old.resolve(tools)
		await vi.waitFor(() => expect(old.close).toHaveBeenCalled())
		expect(service.getServerRuntimes()[0].status).toBe('connecting')
		expect((await service.listMcpTools('alpha')).tools).toEqual([])
		clients[1].resolve(tools)
		await vi.waitFor(() =>
			expect(
				service
					.getServerRuntimes()
					.some((runtime) => runtime.status === 'connecting'),
			).toBe(false),
		)
		expect(service.getServerRuntimes()[0].status).toBe('connected')
	})

	it('keeps a saved config when discovery fails and reports the background result', async () => {
		const { service } = fixture()
		const update = vi.fn()
		const stop = service.onRuntimeChanged(update)
		await service.saveServers({ alpha: config('alpha') })
		clients[0].reject(new Error('Unavailable · 暂不可用 🌐'))
		await vi.waitFor(() =>
			expect(
				service
					.getServerRuntimes()
					.some((runtime) => runtime.status === 'connecting'),
			).toBe(false),
		)
		expect(service.getServers()).toHaveProperty('alpha')
		expect(service.getServerRuntimes()[0]).toMatchObject({
			status: 'error',
			error: 'Unavailable · 暂不可用 🌐',
		})
		expect(update).toHaveBeenCalledTimes(2)
		stop()
	})

	it('does not publish discovery after module revocation', async () => {
		const { scope, service } = fixture()
		await service.saveServers({ alpha: config('alpha') })
		scope.close()
		clients[0].resolve(tools)
		await service.close()
		expect(service.getServerRuntimes()[0].tools).toEqual([])
	})
})

describe('MCP discovery and execution contract', () => {
	it('keeps exactly three definitions unchanged across connection state and session exclusions', async () => {
		const { service } = fixture()
		const before = service.getToolsForSession('neutral-session')
		await service.saveServers({ alpha: config('alpha') })
		clients[0].resolve(tools)
		await vi.waitFor(() =>
			expect(service.getServerRuntimes()[0].status).toBe('connected'),
		)
		const after = service.getToolsForSession('other-session', ['alpha'])
		expect(Object.keys(before)).toEqual([
			'mcp_list_servers',
			'mcp_list_tools',
			'mcp_execute',
		])
		for (const key of [
			'mcp_list_servers',
			'mcp_list_tools',
			'mcp_execute',
		] as const) {
			expect(after[key].description).toEqual(before[key].description)
			expect(z.toJSONSchema(after[key].inputSchema as z.ZodMiniType)).toEqual(
				z.toJSONSchema(before[key].inputSchema as z.ZodMiniType),
			)
		}
		const schema = before.mcp_execute.inputSchema as z.ZodMiniType
		for (const input of [
			{ server: '', tool: 'read_notes', args: {} },
			{ server: 'alpha', tool: '   ', args: {} },
			{ server: 'alpha', tool: 'read_notes', args: [] },
		])
			expect(z.safeParse(schema, input).success).toBe(false)
		const [master, explorer] = createAgentDefinitions()
		expect(Object.keys(filterToolsForAgent(before, master))).toEqual([
			'mcp_list_servers',
			'mcp_list_tools',
			'mcp_execute',
		])
		expect(filterToolsForAgent(before, explorer)).toEqual({})
	})

	it('lists services without waiting and rejects blank names when discovering tools', async () => {
		const { service } = fixture()
		await service.saveServers({ alpha: config('alpha') })
		const expected = await service.listMcpServers()
		for (const server of ['', ' ', '\t\n', '\u3000']) {
			await expect(service.listMcpTools(server)).rejects.toThrow(
				'must not be empty',
			)
			expect(
				z.safeParse(
					service.getToolsForSession('neutral-session').mcp_list_tools
						.inputSchema as z.ZodMiniType,
					{ server },
				).success,
			).toBe(false)
		}
		expect(expected).toEqual([
			{
				server: 'alpha',
				description: '',
				status: 'connecting',
				tools: [],
				error: undefined,
			},
		])
		expect(JSON.stringify(expected)).not.toContain('X-Context')
		expect(JSON.stringify(expected)).not.toContain('example.invalid')
		await expect(
			service.execMcp(
				{ server: 'alpha', tool: 'read_notes', args: {} },
				'neutral-session',
			),
		).rejects.toThrow('not ready')
	})

	it('discovers complete schemas and validates before executing with artifact formatting', async () => {
		const { service } = fixture()
		const inputSchema = {
			type: 'object',
			properties: { query: { type: 'string', minLength: 1 } },
			required: ['query'],
			additionalProperties: false,
		}
		await service.saveServers({ alpha: config('alpha') })
		clients[0].resolve({ tools: [{ ...tools.tools[0], inputSchema }] })
		await vi.waitFor(() =>
			expect(service.getServerRuntimes()[0].status).toBe('connected'),
		)
		const overview = await service.listMcpServers()
		expect(overview).toEqual([
			{
				server: 'alpha',
				description: 'Search notes · 搜索笔记 📝',
				tools: ['read_notes'],
				status: 'connected',
				error: undefined,
			},
		])
		expect(JSON.stringify(overview)).not.toContain('inputSchema')
		expect(JSON.stringify(overview)).not.toContain('toolCount')
		expect(JSON.stringify(overview)).not.toContain(tools.tools[0].description)
		expect(await service.listMcpTools(' alpha ')).toMatchObject({
			server: 'alpha',
			tools: [
				{
					tool: 'read_notes',
					description: tools.tools[0].description,
					inputSchema,
				},
			],
		})
		for (const args of [
			{},
			{ query: 2 },
			{ query: '' },
			{ query: 'Notes 笔记 📝', extra: true },
		]) {
			await expect(
				service.execMcp(
					{ server: 'alpha', tool: 'read_notes', args },
					'neutral-session',
				),
			).rejects.toThrow('Invalid MCP arguments')
		}
		expect(clients[0].call).not.toHaveBeenCalled()
		const controller = new AbortController()
		const args = { query: 'Notes 笔记 📝' }
		const result = await service.execMcp(
			{ server: ' alpha ', tool: 'read_notes', args },
			'neutral-session',
			[],
			controller.signal,
		)
		expect(clients[0].call).toHaveBeenCalledWith(
			{ name: 'read_notes', arguments: args },
			undefined,
			{ signal: controller.signal },
		)
		expect(result).toContain('Notes 笔记 📝')
		expect(formatMcpToolResult).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				sessionId: 'neutral-session',
				serverName: 'alpha',
				toolName: 'read_notes',
			}),
		)
	})

	it('returns the complete definition when execution skips discovery and guesses parameters', async () => {
		const { service } = fixture()
		const inputSchema = {
			type: 'object',
			properties: { query: { type: 'string' }, objective: { type: 'string' } },
			required: ['query', 'objective'],
			additionalProperties: false,
		}
		await service.saveServers({ alpha: config('alpha') })
		clients[0].resolve({ tools: [{ ...tools.tools[0], inputSchema }] })
		await vi.waitFor(() =>
			expect(service.getServerRuntimes()[0].status).toBe('connected'),
		)
		await service.listMcpServers()
		const error = await service
			.execMcp(
				{
					server: 'alpha',
					tool: 'read_notes',
					args: { query: 'Notes 笔记 📝' },
				},
				'neutral-session',
			)
			.catch((error: unknown) => error)
		expect(error).toBeInstanceOf(Error)
		const message = (error as Error).message
		expect(message).toContain('No remote tool was executed')
		const definition = JSON.parse(message.split('\n').at(-1)!)
		expect(definition).toEqual({
			server: 'alpha',
			tool: 'read_notes',
			description: tools.tools[0].description,
			inputSchema,
		})
		expect(clients[0].call).not.toHaveBeenCalled()
		await service.execMcp(
			{
				server: 'alpha',
				tool: definition.tool,
				args: { query: 'Notes 笔记 📝', objective: 'Find notes · 查找笔记 🔎' },
			},
			'neutral-session',
		)
		expect(clients[0].call).toHaveBeenCalledTimes(1)
	})

	it('enforces session exclusions, configured disabling and current configuration at execution', async () => {
		const { service } = fixture()
		await service.saveServers({ alpha: config('alpha') })
		clients[0].resolve(tools)
		await vi.waitFor(() =>
			expect(service.getServerRuntimes()[0].status).toBe('connected'),
		)
		const input = { server: 'alpha', tool: 'read_notes', args: {} }
		const entry = service.getToolsForSession('neutral-session')
		expect(await service.listMcpServers(['alpha'])).toEqual([])
		await expect(service.listMcpTools('alpha', ['alpha'])).rejects.toThrow(
			'disabled',
		)
		await expect(
			service.execMcp(input, 'neutral-session', ['alpha']),
		).rejects.toThrow('disabled')
		await expect(
			service.execMcp({ ...input, tool: 'unknown' }, 'neutral-session'),
		).rejects.toThrow('Unknown MCP tool')
		for (const input of [
			{ server: ' ', tool: 'read_notes', args: {} },
			{ server: 'alpha', tool: '', args: {} },
		]) {
			await expect(service.execMcp(input, 'neutral-session')).rejects.toThrow(
				'must not be empty',
			)
		}
		await service.saveServers({ alpha: { ...config('alpha'), enabled: false } })
		expect(await service.listMcpTools('alpha')).toMatchObject({
			status: 'disabled',
			tools: [],
		})
		await expect(
			entry.mcp_execute.execute!(input, {
				toolCallId: 'neutral-call',
				messages: [],
				context: {},
			}),
		).rejects.toThrow('disabled')
		await service.saveServers({})
		await expect(service.execMcp(input, 'neutral-session')).rejects.toThrow(
			'unavailable',
		)
		expect(clients[0].call).not.toHaveBeenCalled()
	})

	it('reads file changes during MCP calls instead of requiring another chat turn', async () => {
		const { service, adapter } = fixture()
		await service.saveServers({ alpha: config('alpha') })
		clients[0].resolve(tools)
		await vi.waitFor(() =>
			expect(service.getServerRuntimes()[0].status).toBe('connected'),
		)
		await adapter.write(
			'mcp.json',
			JSON.stringify({
				mcpServers: {
					alpha: { ...config('alpha'), enabled: false },
					beta: config('beta'),
				},
			}),
		)
		await expect(
			service.execMcp(
				{ server: 'alpha', tool: 'read_notes', args: {} },
				'neutral-session',
			),
		).rejects.toThrow('disabled')
		expect(await service.listMcpTools('beta')).toMatchObject({
			server: 'beta',
			status: 'connecting',
			tools: [],
		})
		expect(clients[0].call).not.toHaveBeenCalled()
	})

	it('propagates call failures and cancellation without losing other services', async () => {
		const { service } = fixture()
		await service.saveServers({ alpha: config('alpha'), beta: config('beta') })
		for (const client of clients) client.resolve(tools)
		await vi.waitFor(() =>
			expect(
				service
					.getServerRuntimes()
					.every((runtime) => runtime.status === 'connected'),
			).toBe(true),
		)
		clients[0].call.mockRejectedValueOnce(new Error('Unavailable 暂不可用 🌐'))
		const input = { server: 'alpha', tool: 'read_notes', args: {} }
		await expect(service.execMcp(input, 'neutral-session')).rejects.toThrow(
			'Unavailable 暂不可用 🌐',
		)
		await expect(
			service.execMcp({ ...input, server: 'beta' }, 'neutral-session'),
		).resolves.toContain('Notes 笔记 📝')
		const controller = new AbortController()
		controller.abort()
		await expect(
			service.execMcp(input, 'neutral-session', [], controller.signal),
		).rejects.toMatchObject({ name: 'AbortError' })
		expect(clients[0].call).toHaveBeenCalledTimes(1)
	})
})
