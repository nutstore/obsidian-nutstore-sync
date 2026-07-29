import { describe, expect, it } from 'vitest'
import {
	getMcpToolName,
	isMcpServerEnabled,
	isMcpToolName,
	isValidMcpServerName,
	parseMcpServersFile,
	serializeMcpServersFile,
} from './types'

describe('parseMcpServersFile', () => {
	it('parses a valid http server config', () => {
		const servers = parseMcpServersFile(
			JSON.stringify({
				mcpServers: {
					'notes-search': {
						type: 'http',
						url: 'https://example.com/mcp',
						headers: { Authorization: 'Bearer token-123' },
						enabled: true,
					},
				},
			}),
		)
		expect(servers['notes-search']).toEqual({
			type: 'http',
			url: 'https://example.com/mcp',
			headers: { Authorization: 'Bearer token-123' },
			enabled: true,
		})
	})

	it('preserves non-ASCII content in headers', () => {
		const servers = parseMcpServersFile(
			JSON.stringify({
				mcpServers: {
					translate: {
						type: 'http',
						url: 'https://example.com/mcp',
						headers: { 'X-Custom-Greeting': '你好世界' },
					},
				},
			}),
		)
		expect(servers.translate?.headers?.['X-Custom-Greeting']).toBe('你好世界')
	})

	it('returns an empty object for an empty mcpServers map', () => {
		expect(parseMcpServersFile('{"mcpServers":{}}')).toEqual({})
	})

	it('returns an empty object when mcpServers is omitted', () => {
		expect(parseMcpServersFile('{}')).toEqual({})
	})

	it('throws on invalid JSON', () => {
		expect(() => parseMcpServersFile('{not json')).toThrow(/Invalid JSON/)
	})

	it('throws on schema violations', () => {
		expect(() =>
			parseMcpServersFile(
				JSON.stringify({
					mcpServers: { broken: { type: 'http', url: 42 } },
				}),
			),
		).toThrow(/Invalid MCP servers/)
	})

	it('throws on unsupported server types', () => {
		expect(() =>
			parseMcpServersFile(
				JSON.stringify({
					mcpServers: { local: { type: 'stdio', command: 'run' } },
				}),
			),
		).toThrow(/Invalid MCP servers/)
	})

	it('throws on invalid server names', () => {
		expect(() =>
			parseMcpServersFile(
				JSON.stringify({
					mcpServers: {
						'bad name!': { type: 'http', url: 'https://example.com/mcp' },
					},
				}),
			),
		).toThrow(/Invalid MCP server name/)
	})
})

describe('serializeMcpServersFile', () => {
	it('round-trips through parseMcpServersFile', () => {
		const servers = {
			'notes-search': {
				type: 'http' as const,
				url: 'https://example.com/mcp',
				headers: { 'X-Title': '笔记搜索' },
			},
		}
		expect(parseMcpServersFile(serializeMcpServersFile(servers))).toEqual(
			servers,
		)
	})
})

describe('server name and tool name helpers', () => {
	it('accepts valid server names', () => {
		for (const name of ['a', 'server-1', 'my_server', 'Server2', '1bad']) {
			expect(isValidMcpServerName(name)).toBe(true)
		}
	})

	it('rejects invalid server names', () => {
		for (const name of ['', '-bad', 'bad name', 'bad.name', '坏名字']) {
			expect(isValidMcpServerName(name)).toBe(false)
		}
	})

	it('builds and recognizes namespaced tool names', () => {
		const toolName = getMcpToolName('notes-search', 'find_notes')
		expect(toolName).toBe('mcp__notes-search__find_notes')
		expect(isMcpToolName(toolName)).toBe(true)
		expect(isMcpToolName('bash')).toBe(false)
	})
})

describe('isMcpServerEnabled', () => {
	it('treats missing enabled as enabled', () => {
		expect(
			isMcpServerEnabled({ type: 'http', url: 'https://example.com/mcp' }),
		).toBe(true)
	})

	it('respects explicit enabled flag', () => {
		expect(
			isMcpServerEnabled({
				type: 'http',
				url: 'https://example.com/mcp',
				enabled: false,
			}),
		).toBe(false)
	})
})
