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
	private readonly clients = new Map<string, ConnectedMcpServer>()
	private reloadPromise?: Promise<void>

	constructor(private plugin: NutstorePlugin) {
		super()
	}

	override async onload() {
		void this.reload().catch((error) => {
			logger.warn('Failed to initialize MCP servers', error)
		})
	}

	override onunload() {
		void this.closeAllClients()
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
		try {
			const adapter = this.plugin.app.vault.adapter
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
		const adapter = this.plugin.app.vault.adapter
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
		this.servers = servers
		this.parseError = parseError
		this.configMtime = mtime
		await this.reconcileClients()
	}

	private async reconcileClients() {
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
				this.clients.set(name, connected)
				this.connectErrors.delete(name)
			} catch (error) {
				logger.warn(`Failed to connect MCP server '${name}'`, error)
				this.connectErrors.set(name, toErrorMessage(error))
			}
		}
	}

	private async connect(config: McpServerConfig): Promise<ConnectedMcpServer> {
		const client = await this.createClient(config)
		try {
			const { tools } = await client.listTools()
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
			fetch: obsidianFetch,
			requestInit: config.headers ? { headers: config.headers } : undefined,
		})
		await client.connect(transport)
		return client
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
		const vault = this.plugin.app.vault
		await mkdirsVault(vault, dirname(MCP_CONFIG_VAULT_PATH))
		await vault.adapter.write(
			MCP_CONFIG_VAULT_PATH,
			serializeMcpServersFile(servers),
		)
		await this.reload()
	}

	async testConnection(config: McpServerConfig) {
		const client = await this.createClient(config)
		try {
			const { tools } = await client.listTools()
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
			execute: async (input: unknown) => {
				const result = await client.callTool({
					name: toolInfo.name,
					arguments: (input ?? {}) as Record<string, unknown>,
				})
				return formatMcpToolResult(this.plugin.app, {
					sessionId,
					serverName,
					toolName: toolInfo.name,
					result,
				})
			},
		})
	}
}
