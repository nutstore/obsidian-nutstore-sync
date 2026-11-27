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

	it('bounds concurrent adapter.stat calls on large directories while preserving valid entries', async () => {
		const files = Array.from(
			{ length: 60 },
			(_, index) => `目录 Dir 🌱/文档-${index}.md`,
		)
		const folders = Array.from(
			{ length: 20 },
			(_, index) => `目录 Dir 🌱/子目录-${index}📁`,
		)
		const unavailable = new Set([
			'目录 Dir 🌱/文档-7.md',
			'目录 Dir 🌱/子目录-3📁',
		])
		let inflight = 0
		let peakInflight = 0
		const adapter = {
			list: vi.fn(async () => ({ files, folders })),
			stat: vi.fn(async (path: string) => {
				inflight += 1
				peakInflight = Math.max(peakInflight, inflight)
				try {
					await Promise.resolve()
					await Promise.resolve()
					if (unavailable.has(path)) return null
					return { type: path.endsWith('.md') ? 'file' : 'folder' }
				} finally {
					inflight -= 1
				}
			}),
		}

		const result = await listAvailableAdapterEntries(adapter, '目录 Dir 🌱')

		expect(peakInflight).toBeGreaterThan(1)
		expect(peakInflight).toBeLessThanOrEqual(24)
		expect(result.files).toHaveLength(59)
		expect(result.folders).toHaveLength(19)
		expect(result.files).not.toContain('目录 Dir 🌱/文档-7.md')
		expect(result.folders).not.toContain('目录 Dir 🌱/子目录-3📁')
	})
})
