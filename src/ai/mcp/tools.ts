import { tool } from 'ai'
import * as z from 'zod/mini'
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
				'List configured MCP services (names, descriptions, tool names, connection status; no schemas or credentials). Discovery does not wait for remote connections; do not poll connecting services.',
			inputSchema: z.object({}),
			execute: () => service.listMcpServers(disabledServers),
		}),
		mcp_list_tools: tool({
			description:
				'List full tool definitions (names, descriptions, inputSchemas) for one ready MCP service name from mcp_list_servers.',
			inputSchema: z.object({ server: serviceName }),
			execute: ({ server }) => service.listMcpTools(server, disabledServers),
		}),
		mcp_execute: tool({
			description:
				'Execute a tool on a ready, enabled MCP service. Before the first call, obtain its current inputSchema via mcp_list_tools unless already in context — never infer args from tool names. Validation failures skip the remote call and return the full tool definition so you can fix args and retry; unknown tools require re-running mcp_list_tools. Large results may be saved as artifacts readable via bash or view_image.',
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
