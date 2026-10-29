import { throwIfAborted } from '~/utils/abort'
import { guardAppIO } from '~/modules/guard-io'
import type { ModuleScope } from '~/modules/lifecycle'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
	jsonSchemaValidator,
	JsonSchemaValidatorResult,
} from '@modelcontextprotocol/sdk/validation/types.js'
import { Validator } from '@cfworker/json-schema'
import { createMcpTools } from '~/ai/mcp/tools'
import { dirname } from 'path-browserify'
import {
	isMcpServerEnabled,
	MCP_CONFIG_VAULT_PATH,
	type McpServerConfig,
	type McpServerConfigs,
	parseMcpServersFile,
	serializeMcpServersFile,
} from '~/ai/mcp/types'
import { formatMcpToolResult } from '~/ai/mcp/result-artifact'
import { obsidianFetch } from '~/ai/transport/obsidian-fetch'
import logger from '~/utils/logger'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import type NutstorePlugin from '..'
import { BaseService } from './service.interface'

export type McpServerStatus = 'connecting' | 'connected' | 'error'

export interface McpToolInfo {
	name: string
	description?: string
	inputSchema: Record<string, unknown>
}

export interface McpServerRuntimeInfo {
	name: string
	enabled: boolean
	status?: McpServerStatus
	error?: string
	tools: McpToolInfo[]
}

interface ConnectedMcpServer {
	description: string
	client: Client
	signature: string
	tools: McpToolInfo[]
}

const noopJsonSchemaValidator: jsonSchemaValidator = {
	getValidator:
		<T>() =>
		(input: unknown): JsonSchemaValidatorResult<T> => ({
			valid: true,
			data: input as T,
			errorMessage: undefined,
		}),
}

function describeMcpTool(info: McpToolInfo) {
	return {
		tool: info.name,
		description: info.description,
		inputSchema: info.inputSchema,
	}
}

function toErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

export default class McpService extends BaseService {
	private servers: McpServerConfigs = {}
	private parseError?: string
	private configMtime?: number
	private get app() {
		return guardAppIO(this.plugin.app, this.scope.check, this.scope.track)
	}
	private readonly clients = new Map<string, ConnectedMcpServer>()
	/** File operations serialize; remote discovery never holds this queue. */
	private configQueue: Promise<void> = Promise.resolve()
	private readonly connections = new Map<
		string,
		{ signature: string; promise: Promise<void> }
	>()
	private readonly runtimeListeners = new Set<() => void>()

	onRuntimeChanged(listener: () => void) {
		this.runtimeListeners.add(listener)
		return () => {
			this.runtimeListeners.delete(listener)
		}
	}

	private notifyRuntimeChanged() {
		for (const listener of this.runtimeListeners) listener()
	}

	private enqueueConfig(work: () => Promise<void>) {
		const result = this.configQueue.then(() => {
			this.scope.check()
			return work()
		})
		this.configQueue = result.catch(() => {})
		return result
	}

	constructor(
		private plugin: NutstorePlugin,
		private readonly scope: ModuleScope,
	) {
		super()
	}

	async close() {
		await this.closeAllClients()
		await this.configQueue
		await Promise.allSettled(
			[...this.connections.values()].map((attempt) => attempt.promise),
		)
		this.runtimeListeners.clear()
		await this.closeAllClients()
	}

	getServers(): McpServerConfigs {
		return this.servers
	}

	getParseError(): string | undefined {
		return this.parseError
	}

	getServerRuntimes(): McpServerRuntimeInfo[] {
		return Object.entries(this.servers).map(([name, config]) => {
			const enabled = isMcpServerEnabled(config)
			const connected = this.clients.get(name)
			return {
				name,
				enabled,
				status: connected
					? 'connected'
					: enabled
						? this.connections.has(name)
							? 'connecting'
							: this.connectErrors.has(name)
								? 'error'
								: undefined
						: undefined,
				error: enabled && !connected ? this.getConnectError(name) : undefined,
				tools: connected?.tools ?? [],
			}
		})
	}

	private readonly connectErrors = new Map<string, string>()

	private getConnectError(name: string) {
		return this.connectErrors.get(name)
	}

	async reload() {
		return this.enqueueConfig(() => this.reloadInternal())
	}

	/**
	 * Re-reads the config file when its mtime changed. Called by MCP discovery and execution
	 * so edits made by the model (via the bash tool) take effect without a
	 * file watcher (dotfiles produce no vault events).
	 */
	async refreshIfChanged() {
		this.scope.check()
		try {
			const adapter = this.app.vault.adapter
			if (!(await adapter.exists(MCP_CONFIG_VAULT_PATH))) {
				if (
					this.configMtime !== undefined ||
					Object.keys(this.servers).length
				) {
					await this.reload()
				}
				return
			}
			const stat = await adapter.stat(MCP_CONFIG_VAULT_PATH)
			if (stat && stat.mtime !== this.configMtime) {
				await this.reload()
			}
		} catch (error) {
			logger.warn('Failed to check MCP config changes', error)
		}
	}

	private async reloadInternal() {
		this.scope.check()
		const adapter = this.app.vault.adapter
		let servers: McpServerConfigs = {}
		let parseError: string | undefined
		let mtime: number | undefined
		try {
			if (await adapter.exists(MCP_CONFIG_VAULT_PATH)) {
				const [text, stat] = await Promise.all([
					adapter.read(MCP_CONFIG_VAULT_PATH),
					adapter.stat(MCP_CONFIG_VAULT_PATH),
				])
				mtime = stat?.mtime
				servers = parseMcpServersFile(text)
			}
		} catch (error) {
			parseError = toErrorMessage(error)
			logger.warn('Failed to load MCP config', error)
		}
		this.scope.check()
		this.servers = servers
		this.parseError = parseError
		this.configMtime = mtime
		this.reconcileClients()
	}

	/** Each server discovers tools independently; stale attempts cannot publish. */
	private reconcileClients() {
		this.scope.check()
		for (const [name, connected] of this.clients) {
			const config = this.servers[name]
			if (
				!config ||
				!isMcpServerEnabled(config) ||
				JSON.stringify(config) !== connected.signature
			) {
				this.clients.delete(name)
				void this.scope.background(
					() => connected.client.close(),
					(error) => logger.warn('Failed to close MCP client', error),
				)
			}
		}
		for (const name of this.connections.keys()) {
			const config = this.servers[name]
			if (!config || !isMcpServerEnabled(config)) this.connections.delete(name)
		}
		for (const name of this.connectErrors.keys()) {
			if (!this.servers[name] || !isMcpServerEnabled(this.servers[name]))
				this.connectErrors.delete(name)
		}
		for (const [name, config] of Object.entries(this.servers)) {
			if (!isMcpServerEnabled(config) || this.clients.has(name)) continue
			const signature = JSON.stringify(config)
			if (this.connections.get(name)?.signature === signature) continue
			this.connectErrors.delete(name)
			const attempt = { signature, promise: Promise.resolve() }
			this.connections.set(name, attempt)
			attempt.promise = this.scope.background(
				async () => {
					try {
						const connected = await this.connect(config)
						const current = this.servers[name]
						if (
							this.scope.signal.aborted ||
							this.connections.get(name) !== attempt ||
							!current ||
							!isMcpServerEnabled(current) ||
							JSON.stringify(current) !== signature
						) {
							await connected.client.close().catch(() => {})
							return
						}
						this.clients.set(name, connected)
						this.connectErrors.delete(name)
					} catch (error) {
						if (
							this.scope.signal.aborted ||
							this.connections.get(name) !== attempt ||
							JSON.stringify(this.servers[name]) !== signature
						)
							return
						logger.warn(`Failed to connect MCP server '${name}'`, error)
						this.connectErrors.set(name, toErrorMessage(error))
					} finally {
						if (this.connections.get(name) === attempt)
							this.connections.delete(name)
						if (!this.scope.signal.aborted) this.notifyRuntimeChanged()
					}
				},
				(error) => logger.warn('Failed to reconcile MCP client', error),
			)
			this.scope.track(attempt.promise)
		}
		this.notifyRuntimeChanged()
	}

	private async connect(config: McpServerConfig): Promise<ConnectedMcpServer> {
		const client = await this.createClient(config)
		try {
			const { tools } = await this.scope.wait(client.listTools())
			return {
				client,
				description:
					client.getServerVersion()?.description ??
					client.getInstructions() ??
					'',
				signature: JSON.stringify(config),
				tools: tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema ?? {
						type: 'object',
						properties: {},
					},
				})),
			}
		} catch (error) {
			await client.close().catch(() => undefined)
			throw error
		}
	}

	private async createClient(config: McpServerConfig): Promise<Client> {
		this.scope.check()
		if (config.type !== 'http') {
			throw new Error('Unsupported MCP server type')
		}
		const client = new Client(
			{
				name: 'obsidian-nutstore-sync',
				version: this.plugin.manifest.version,
			},
			{ jsonSchemaValidator: noopJsonSchemaValidator },
		)
		const transport = new StreamableHTTPClientTransport(new URL(config.url), {
			fetch: (input, init) => {
				this.scope.check()
				return this.scope.wait(obsidianFetch(input, init))
			},
			requestInit: config.headers ? { headers: config.headers } : undefined,
		})
		const release = this.scope.register(() => {
			const closing = client.close()
			this.scope.track(closing)
			void closing.catch(() => {})
		})
		client.onclose = release
		try {
			await this.scope.wait(client.connect(transport))
			return client
		} catch (error) {
			release()
			await client.close().catch(() => {})
			throw error
		}
	}

	private async closeClient(name: string) {
		const connected = this.clients.get(name)
		this.clients.delete(name)
		if (connected) {
			await connected.client.close().catch(() => undefined)
		}
	}

	private async closeAllClients() {
		for (const name of [...this.clients.keys()]) {
			await this.closeClient(name)
		}
	}

	async saveServers(
		update:
			McpServerConfigs | ((current: McpServerConfigs) => McpServerConfigs),
	) {
		return this.enqueueConfig(async () => {
			const servers =
				typeof update === 'function' ? update(this.servers) : update
			const vault = this.app.vault
			await mkdirsVault(vault, dirname(MCP_CONFIG_VAULT_PATH))
			await vault.adapter.write(
				MCP_CONFIG_VAULT_PATH,
				serializeMcpServersFile(servers),
			)
			await this.reloadInternal()
		})
	}

	async testConnection(config: McpServerConfig) {
		this.scope.check()
		const client = await this.createClient(config)
		try {
			const { tools } = await this.scope.wait(client.listTools())
			return tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
			}))
		} finally {
			await client.close().catch(() => undefined)
		}
	}

	/** Definitions never depend on connected servers or discovered tool schemas. */
	getToolsForSession(
		sessionId: string,
		disabledServers: readonly string[] = [],
	) {
		this.scope.check()
		return createMcpTools(this, sessionId, disabledServers)
	}

	/** The compact directory contains tool names only, never tool schemas or descriptions. */
	async listMcpServers(disabledServers: readonly string[] = []) {
		await this.refreshIfChanged()
		this.scope.check()
		if (this.parseError) throw new Error(this.parseError)
		return this.getServerRuntimes()
			.filter((runtime) => !disabledServers.includes(runtime.name))
			.map((runtime) => ({
				server: runtime.name,
				description: this.clients.get(runtime.name)?.description ?? '',
				tools: runtime.tools.map((info) => info.name),
				status: runtime.enabled ? (runtime.status ?? 'connecting') : 'disabled',
				error: runtime.error,
			}))
	}

	/** One service name always yields the same detailed tool-definition shape. */
	async listMcpTools(server: string, disabledServers: readonly string[] = []) {
		const name = server.trim()
		if (!name) throw new Error('MCP service name must not be empty.')
		await this.refreshIfChanged()
		this.scope.check()
		if (this.parseError) throw new Error(this.parseError)
		const runtime = this.getServerRuntimes().find(
			(runtime) => runtime.name === name && !disabledServers.includes(name),
		)
		if (!runtime)
			throw new Error(
				`MCP service '${name}' is unavailable or disabled for this session.`,
			)
		return {
			server: runtime.name,
			status: runtime.enabled ? (runtime.status ?? 'connecting') : 'disabled',
			error: runtime.error,
			tools: runtime.tools.map(describeMcpTool),
		}
	}

	/** Resolve against current state so removed, changed or disabled services cannot execute. */
	async execMcp(
		input: { server: string; tool: string; args: Record<string, unknown> },
		sessionId: string,
		disabledServers: readonly string[] = [],
		abortSignal?: AbortSignal,
	) {
		throwIfAborted(abortSignal)
		await this.refreshIfChanged()
		this.scope.check()
		throwIfAborted(abortSignal)
		const server = input.server.trim()
		const toolName = input.tool.trim()
		if (!server || !toolName)
			throw new Error('MCP service name and tool name must not be empty.')
		const config = this.servers[server]
		if (
			!config ||
			!isMcpServerEnabled(config) ||
			disabledServers.includes(server)
		) {
			throw new Error(`MCP service '${server}' is unavailable or disabled.`)
		}
		const connected = this.clients.get(server)
		if (!connected || connected.signature !== JSON.stringify(config)) {
			throw new Error(
				`MCP service '${server}' is not ready. Use mcp_list_servers to inspect its connection status.`,
			)
		}
		const info = connected.tools.find((info) => info.name === toolName)
		if (!info)
			throw new Error(
				`Unknown MCP tool '${toolName}'. Use mcp_list_tools with this service name to discover tools.`,
			)
		const validation = new Validator(info.inputSchema, '2020-12').validate(
			input.args,
		)
		if (!validation.valid) {
			throw new Error(
				[
					`Invalid MCP arguments: ${validation.errors.map((error) => `${error.instanceLocation || '/'}: ${error.error}`).join('; ')}`,
					'No remote tool was executed. Correct all arguments using the complete definition below, then retry mcp_execute. Do not guess parameters from prior knowledge.',
					JSON.stringify({ server, ...describeMcpTool(info) }),
				].join('\n'),
			)
		}
		const result = await this.scope.wait(
			connected.client.callTool(
				{ name: toolName, arguments: input.args },
				undefined,
				{ signal: abortSignal ?? this.scope.signal },
			),
		)
		this.scope.check()
		throwIfAborted(abortSignal)
		return formatMcpToolResult(
			guardAppIO(this.app, () => throwIfAborted(abortSignal)),
			{ sessionId, serverName: server, toolName, result },
		)
	}
}
