import { throwIfAborted } from '~/utils/abort'
import { guardAppIO } from '~/modules/guard-io'
import type { ModuleScope } from '~/modules/lifecycle'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type {
	jsonSchemaValidator,
	JsonSchemaValidatorResult,
} from '@modelcontextprotocol/sdk/validation/types.js'
import { dynamicTool, jsonSchema, type ToolSet } from 'ai'
import { dirname } from 'path-browserify'
import {
	getMcpToolName,
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
	private reloadPromise?: Promise<void>

	constructor(
		private plugin: NutstorePlugin,
		private readonly scope: ModuleScope,
	) {
		super()
	}

	async close() {
		await this.closeAllClients()
		await this.reloadPromise?.catch(() => {})
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
				status: connected ? 'connected' : enabled ? 'error' : undefined,
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
		this.scope.check()
		if (this.reloadPromise) {
			return this.reloadPromise
		}
		const promise = this.reloadInternal()
		this.reloadPromise = promise
		try {
			await promise
		} finally {
			if (this.reloadPromise === promise) {
				this.reloadPromise = undefined
			}
		}
	}

	/**
	 * Re-reads the config file when its mtime changed. Called before each agent
	 * turn so edits made by the model (via the bash tool) take effect without a
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
		await this.reconcileClients()
	}

	private async reconcileClients() {
		this.scope.check()
		const desired = new Map(
			Object.entries(this.servers).filter(([, config]) =>
				isMcpServerEnabled(config),
			),
		)
		for (const [name, connected] of [...this.clients]) {
			const config = desired.get(name)
			if (!config || JSON.stringify(config) !== connected.signature) {
				await this.closeClient(name)
			}
		}
		for (const [name, config] of desired) {
			if (this.clients.has(name)) {
				continue
			}
			try {
				const connected = await this.connect(config)
				this.scope.check()
				this.clients.set(name, connected)
				this.connectErrors.delete(name)
			} catch (error) {
				if (this.scope.signal.aborted) return
				logger.warn(`Failed to connect MCP server '${name}'`, error)
				this.connectErrors.set(name, toErrorMessage(error))
			}
		}
	}

	private async connect(config: McpServerConfig): Promise<ConnectedMcpServer> {
		const client = await this.createClient(config)
		try {
			const { tools } = await this.scope.wait(client.listTools())
			return {
				client,
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

	async saveServers(servers: McpServerConfigs) {
		this.scope.check()
		const vault = this.app.vault
		await mkdirsVault(vault, dirname(MCP_CONFIG_VAULT_PATH))
		await vault.adapter.write(
			MCP_CONFIG_VAULT_PATH,
			serializeMcpServersFile(servers),
		)
		await this.reload()
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

	/**
	 * Builds AI SDK tools for all connected servers, excluding servers disabled
	 * for the given session. Tool names are namespaced as
	 * `mcp__<serverName>__<toolName>`.
	 */
	getToolsForSession(
		sessionId: string,
		disabledServers: readonly string[] = [],
	): ToolSet {
		this.scope.check()
		const disabled = new Set(disabledServers)
		const result: ToolSet = {}
		for (const [name, connected] of this.clients) {
			if (disabled.has(name)) {
				continue
			}
			for (const toolInfo of connected.tools) {
				result[getMcpToolName(name, toolInfo.name)] = this.createTool(
					connected.client,
					toolInfo,
					name,
					sessionId,
				)
			}
		}
		return result
	}

	private createTool(
		client: Client,
		toolInfo: McpToolInfo,
		serverName: string,
		sessionId: string,
	) {
		return dynamicTool({
			description: toolInfo.description ?? `MCP tool: ${toolInfo.name}`,
			inputSchema: jsonSchema(toolInfo.inputSchema),
			execute: async (input: unknown, { abortSignal }) => {
				throwIfAborted(abortSignal)
				this.scope.check()
				const result = await this.scope.wait(
					client.callTool(
						{
							name: toolInfo.name,
							arguments: (input ?? {}) as Record<string, unknown>,
						},
						undefined,
						{ signal: abortSignal ?? this.scope.signal },
					),
				)
				this.scope.check()
				return formatMcpToolResult(
					guardAppIO(this.app, () => throwIfAborted(abortSignal)),
					{
						sessionId,
						serverName,
						toolName: toolInfo.name,
						result,
					},
				)
			},
		})
	}
}
