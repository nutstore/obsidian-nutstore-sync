import { z } from 'zod/mini'
import { NUTSTORE_SYNC_AGENTS_MOUNT_POINT } from '~/ai/tools/bash/mount-points'

export const MCP_CONFIG_VAULT_PATH = '.agents/nutstore-sync/mcp.json'
export const MCP_CONFIG_VIRTUAL_PATH = `${NUTSTORE_SYNC_AGENTS_MOUNT_POINT}/mcp.json`

export const MCP_TOOL_NAME_PREFIX = 'mcp__'

const MCP_SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i

const httpMcpServerConfigSchema = z.object({
	type: z.literal('http'),
	url: z.string(),
	headers: z.optional(z.record(z.string(), z.string())),
	enabled: z.optional(z.boolean()),
})

export const mcpServerConfigSchema = z.discriminatedUnion('type', [
	httpMcpServerConfigSchema,
])

export const mcpServersFileSchema = z.object({
	mcpServers: z.optional(z.record(z.string(), mcpServerConfigSchema)),
})

export type HttpMcpServerConfig = z.infer<typeof httpMcpServerConfigSchema>
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>
export type McpServersFile = z.infer<typeof mcpServersFileSchema>
export type McpServerConfigs = Record<string, McpServerConfig>

export function isValidMcpServerName(name: string) {
	return MCP_SERVER_NAME_PATTERN.test(name)
}

export function getMcpToolName(serverName: string, toolName: string) {
	return `${MCP_TOOL_NAME_PREFIX}${serverName}__${toolName}`
}

export function isMcpToolName(name: string) {
	return name.startsWith(MCP_TOOL_NAME_PREFIX)
}

function formatSchemaIssues(error: z.core.$ZodError): string {
	return error.issues
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
			return `${path}: ${issue.message}`
		})
		.join('; ')
}

export function parseMcpServersFile(text: string): McpServerConfigs {
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch (error) {
		throw new Error(
			`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		)
	}
	const parsed = mcpServersFileSchema.safeParse(raw)
	if (!parsed.success) {
		throw new Error(`Invalid MCP servers: ${formatSchemaIssues(parsed.error)}`)
	}
	const servers = parsed.data.mcpServers ?? {}
	for (const name of Object.keys(servers)) {
		if (!isValidMcpServerName(name)) {
			throw new Error(
				`Invalid MCP server name '${name}': use letters, numbers, hyphens and underscores only.`,
			)
		}
	}
	return servers
}

export function serializeMcpServersFile(servers: McpServerConfigs): string {
	return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`
}

export function isMcpServerEnabled(config: McpServerConfig) {
	return config.enabled !== false
}
