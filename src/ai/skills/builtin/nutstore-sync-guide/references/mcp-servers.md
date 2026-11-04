# MCP Server Configuration

Use this reference when the user asks to add, edit, remove, or diagnose an MCP
server.

## Configuration workflow

1. The file is a real vault file at `.agents/nutstore-sync/mcp.json`, visible
   to the tools at `/.agents/nutstore-sync/mcp.json`.
2. Read the file first when it exists: `cat /.agents/nutstore-sync/mcp.json`.
   Preserve unrelated server entries unless the user asks to remove them.
3. The file is a JSON object with a top-level `mcpServers` map. Each server
   name must use letters, numbers, hyphens, or underscores, and must start with
   a letter or number.
4. Only HTTP servers are supported. A server entry has `type: "http"`, a
   `url`, optional string `headers`, and optional boolean `enabled`. A server
   with `enabled: false` is disabled; in-file `enabled: false`
   differs from disabling a server for one chat session.
5. To add, edit, or remove a server, rewrite the complete `mcpServers` map with
   `jq` on the current contents or an `apply_patch` update (read the file before
   patching). Keep the JSON valid and intact, and never drop other servers.
6. Handle headers as secrets: retain existing values where possible and never
   include their values in a chat response.
7. Use `mcp_list_servers({})` for the compact service directory: service names,
   service descriptions, tool names as string arrays, and connection status.
   Tool descriptions and parameter schemas are deliberately omitted here.
8. Use `mcp_list_tools({"server":"notes-service"})` for the selected service's
   complete tool names, descriptions and input schemas. `server` matches the
   editor's Service name field and must not be empty or whitespace-only.
   Read these schemas before execution; never guess argument names.
9. Execute with `mcp_execute({"server":"notes-service","tool":"read_notes","args":{}})`
   using the exact discovered tool name and arguments matching its schema.
   Discovery and execution check configuration changes when called. Connections
   and tool discovery happen in the background; a connecting service is not
   ready yet. Do not claim its tools are available or repeatedly poll it.
   A service disabled for this session cannot be listed or executed.

Use this neutral example only when the user needs the file format:

```json
{
	"mcpServers": {
		"notes-service": {
			"type": "http",
			"url": "https://example.com/mcp",
			"enabled": true
		}
	}
}
```

If connection or parsing fails, explain the observed error and check the
server name, JSON syntax, URL, and header names before proposing a change.
