import { tool } from 'ai'
import { z } from 'zod/mini'
import type McpService from '~/services/mcp.service'

const serviceName = z.string().check(z.trim(), z.minLength(1))

/** Keep model-facing definitions fixed; discover remote schemas in tool results. */
export function createMcpTools(
	service: McpService,
	sessionId: string,
	disabledServers: readonly string[],
) {
	return {
		mcp_list_servers: tool({
			description:
				'List configured MCP services as an array of service names, service descriptions, tool names (string arrays), and connection status. This is a compact directory: tool descriptions and parameter schemas are deliberately omitted. The next step after selecting a service MUST be mcp_list_tools, unless its complete current input schema is already in this conversation. A familiar tool name does not imply a familiar schema. No credentials are returned. Discovery does not wait for remote connections; do not repeatedly poll connecting services.',
			inputSchema: z.object({}),
			execute: () => service.listMcpServers(disabledServers),
		}),
		mcp_list_tools: tool({
			description:
				'List the complete tool definitions for one MCP service: exact tool names, descriptions and input schemas. server is the service name configured in the MCP editor and returned by mcp_list_servers; it must be nonempty. Read these schemas before using mcp_execute; never guess argument names. Connecting services are not ready yet. Discovery does not wait for remote connections.',
			inputSchema: z.object({ server: serviceName }),
			execute: ({ server }) => service.listMcpTools(server, disabledServers),
		}),
		mcp_execute: tool({
			description:
				'Execute a discovered MCP tool. server is the configured MCP service name; tool is the exact tool name returned by mcp_list_tools. Supply args matching its inputSchema. Before the first call, you MUST obtain the complete input schema from mcp_list_tools; mcp_list_servers alone is insufficient. Do not infer arguments from tool names or prior knowledge. If argument validation fails, no remote call occurs and the error includes the complete tool definition: correct all arguments from it and retry. For an unknown tool, call mcp_list_tools again. Only ready, enabled services are callable. Tool results may reference saved artifacts that can be read with bash or view_image.',
			inputSchema: z.object({
				server: serviceName,
				tool: serviceName,
				args: z.record(z.string(), z.unknown()),
			}),
			execute: (input, { abortSignal }) =>
				service.execMcp(input, sessionId, disabledServers, abortSignal),
		}),
	}
}
