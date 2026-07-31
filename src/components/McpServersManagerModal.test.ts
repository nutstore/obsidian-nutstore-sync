import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpServerDraft } from './McpServerEditorModal'
import McpServersManagerModal from './McpServersManagerModal'
import type NutstorePlugin from '..'
import logger from '~/utils/logger'

describe('McpServersManagerModal saving', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('keeps the editor open when saving a bilingual draft fails', async () => {
		vi.spyOn(logger, 'error').mockImplementation(() => undefined)
		const saveServers = vi.fn(async () => {
			throw new Error('Example save failure / 示例保存失败')
		})
		const plugin = {
			app: {},
			mcpService: {
				getServers: () => ({}),
				saveServers,
			},
		} as unknown as NutstorePlugin
		const modal = new McpServersManagerModal(plugin, vi.fn())
		const saveDraft = (
			modal as unknown as {
				saveDraft: (draft: McpServerDraft) => Promise<boolean>
			}
		).saveDraft.bind(modal)

		await expect(
			saveDraft({
				name: 'neutral-server',
				config: {
					type: 'http',
					url: 'https://example.com/mcp',
					headers: { 'X-Example': '示例' },
				},
			}),
		).resolves.toBe(false)
	})
})
