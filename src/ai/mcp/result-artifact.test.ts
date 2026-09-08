import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatMcpToolResult } from './result-artifact'
import { BASH_TMP_MOUNT_POINT } from '~/ai/tools/bash/mount-points'

const writes = vi.hoisted(() => ({
	binary: vi.fn(),
	exists: vi.fn(),
	text: vi.fn(),
}))

vi.mock('~/ai/tools/bash/tmp-fs', () => ({
	existsBashTmpPath: writes.exists,
	writeBashTmpBinary: writes.binary,
	writeBashTmpText: writes.text,
}))

vi.mock('id-agent', () => ({
	idAgent: () => 'mcp-neutral-result',
}))

describe('formatMcpToolResult', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		writes.exists.mockResolvedValue(false)
	})

	it('returns errors inline without writing temporary files', async () => {
		const output = await formatMcpToolResult(
			{} as Parameters<typeof formatMcpToolResult>[0],
			{
				sessionId: 'session-neutral',
				serverName: 'neutral-server',
				toolName: 'example-tool',
				result: {
					isError: true,
					content: [{ type: 'text', text: 'Example error / 示例错误' }],
				},
			},
		)

		expect(output).toContain('MCP tool returned an error')
		expect(output).toContain('Example error / 示例错误')
		expect(writes.text).not.toHaveBeenCalled()
		expect(writes.binary).not.toHaveBeenCalled()
	})

	it('returns short bilingual text inline', async () => {
		const output = await formatMcpToolResult(
			{} as Parameters<typeof formatMcpToolResult>[0],
			{
				sessionId: 'session-neutral',
				serverName: 'neutral-server',
				toolName: 'example-tool',
				result: {
					content: [{ type: 'text', text: 'Example result / 示例结果' }],
				},
			},
		)

		expect(output).toBe('Example result / 示例结果')
		expect(writes.text).not.toHaveBeenCalled()
	})

	it('writes long text to a Markdown manifest', async () => {
		const output = await formatMcpToolResult(
			{} as Parameters<typeof formatMcpToolResult>[0],
			{
				sessionId: 'session-neutral',
				serverName: 'neutral-server',
				toolName: 'example-tool',
				result: {
					content: [
						{ type: 'text', text: `Example / 示例 ${'x'.repeat(21 * 1024)}` },
					],
				},
			},
		)

		expect(output).toContain(
			`${BASH_TMP_MOUNT_POINT}/session-neutral/mcp/mcp-neutral-result/result.md`,
		)
		expect(writes.exists).toHaveBeenCalledWith(
			expect.anything(),
			`${BASH_TMP_MOUNT_POINT}/session-neutral/mcp/mcp-neutral-result`,
		)
		expect(writes.text).toHaveBeenCalledOnce()
		expect(writes.binary).not.toHaveBeenCalled()
	})

	it('writes media and resources to a Markdown manifest', async () => {
		const output = await formatMcpToolResult(
			{} as Parameters<typeof formatMcpToolResult>[0],
			{
				sessionId: 'session-neutral',
				serverName: 'neutral-server',
				toolName: 'example-tool',
				result: {
					structuredContent: { status: '示例 / example' },
					content: [
						{ type: 'text', text: 'Example result / 示例结果' },
						{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
						{ type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' },
						{
							type: 'resource',
							resource: {
								uri: 'file:///example.txt',
								mimeType: 'text/plain',
								text: 'Resource example / 资源示例',
							},
						},
						{
							type: 'resource_link',
							uri: 'https://example.com/example.pdf',
							name: 'example.pdf',
							mimeType: 'application/pdf',
						},
					],
				},
			},
		)

		expect(output).toContain(
			`${BASH_TMP_MOUNT_POINT}/session-neutral/mcp/mcp-neutral-result/result.md`,
		)
		expect(writes.binary).toHaveBeenNthCalledWith(
			1,
			expect.anything(),
			`${BASH_TMP_MOUNT_POINT}/session-neutral/mcp/mcp-neutral-result/image-2.png`,
			new Uint8Array([105, 109, 97, 103, 101]),
		)
		expect(writes.binary).toHaveBeenNthCalledWith(
			2,
			expect.anything(),
			`${BASH_TMP_MOUNT_POINT}/session-neutral/mcp/mcp-neutral-result/audio-3.wav`,
			new Uint8Array([97, 117, 100, 105, 111]),
		)
		expect(writes.text).toHaveBeenCalledOnce()
		const markdown = writes.text.mock.calls[0]?.[2] as string
		expect(markdown).toContain('Example result / 示例结果')
		expect(markdown).toContain('Resource example / 资源示例')
		expect(markdown).toContain(
			`${BASH_TMP_MOUNT_POINT}/session-neutral/mcp/mcp-neutral-result/image-2.png`,
		)
		expect(markdown).toContain(
			`${BASH_TMP_MOUNT_POINT}/session-neutral/mcp/mcp-neutral-result/audio-3.wav`,
		)
		expect(markdown).toContain('https://example.com/example.pdf')
	})
})
