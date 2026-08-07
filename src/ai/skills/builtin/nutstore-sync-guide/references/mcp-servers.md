# MCP Server Configuration

Use this reference when the user asks to add, edit, remove, or diagnose an MCP
server.

## Configuration workflow

1. Read `/.agents/nutstore-sync/mcp.json` first when it exists. Preserve
   unrelated server entries unless the user asks to remove them.
2. The file is a JSON object with a top-level `mcpServers` map. Each server
   name must use letters, numbers, hyphens, or underscores, and must start with
   a letter or number.
3. Only HTTP servers are supported. A server entry has `type: "http"`, a
   `url`, optional string `headers`, and optional boolean `enabled`.
4. Handle headers as secrets: retain existing values where possible and never
   include their values in a chat response.
5. Editing this file changes the global MCP server configuration. A server
   disabled in the ChatBox applies only to that chat session and is separate
   from the file's `enabled` field.
6. MCP tools are refreshed before the next agent turn. After changing the
   file, tell the user that the configuration will take effect on their next
   message.

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
