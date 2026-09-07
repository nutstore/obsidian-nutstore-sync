import { describe, expect, it, vi } from 'vitest'
import { listAvailableAdapterEntries } from './available-adapter-entries'

describe('listAvailableAdapterEntries', () => {
	it('omits entries that the adapter cannot stat while retaining available files and folders', async () => {
		const adapter = {
			list: vi.fn(async () => ({
				files: ['.agents/中性记录 🌿.md'],
				folders: ['.agents/available', '.agents/unavailable'],
			})),
			stat: vi.fn(async (path: string) => {
				if (path === '.agents/unavailable') {
					throw new Error(`ENOENT: ${path}`)
				}
				return { type: path.endsWith('.md') ? 'file' : 'folder' }
			}),
		}

		await expect(
			listAvailableAdapterEntries(adapter as never, '.agents'),
		).resolves.toEqual({
			files: ['.agents/中性记录 🌿.md'],
			folders: ['.agents/available'],
		})
	})
})
