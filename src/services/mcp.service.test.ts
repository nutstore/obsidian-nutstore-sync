import { describe, expect, it, vi } from 'vitest'
import type NutstorePlugin from '..'
import McpService from './mcp.service'

describe('McpService startup', () => {
	it('does not wait for an MCP connection during plugin load', async () => {
		const service = new McpService({} as NutstorePlugin)
		vi.spyOn(service, 'reload').mockReturnValue(new Promise(() => undefined))

		await expect(service.onload()).resolves.toBeUndefined()
	})
})
