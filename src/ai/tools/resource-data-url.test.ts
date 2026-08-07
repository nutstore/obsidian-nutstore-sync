import type { App } from 'obsidian'
import { describe, expect, it, vi } from 'vitest'

import { resolveResourceDataUrl } from './resource-data-url'

function createApp(files: Record<string, string>) {
	const readBinary = vi.fn(async (path: string) => {
		const content = files[path]
		if (content === undefined) throw new Error(`Missing file: ${path}`)
		return new TextEncoder().encode(content).buffer
	})
	return {
		app: {
			vault: {
				configDir: '.obsidian',
				adapter: { readBinary },
			},
		} as unknown as App,
		readBinary,
	}
}

describe('resolveResourceDataUrl', () => {
	it('resolves an English vault path', async () => {
		const { app, readBinary } = createApp({ 'images/example.png': 'abc' })

		await expect(
			resolveResourceDataUrl(app, '/vault/images/example.png', 'image/png'),
		).resolves.toBe('data:image/png;base64,YWJj')
		expect(readBinary).toHaveBeenCalledWith('images/example.png')
	})

	it('resolves a Chinese temporary path', async () => {
		const adapterPath = '.agents/nutstore-sync/tmp/session/mcp/示例.png'
		const { app, readBinary } = createApp({ [adapterPath]: '示例' })

		const result = await resolveResourceDataUrl(
			app,
			'/tmp/session/mcp/示例.png',
			'image/png',
		)

		expect(result).toMatch(/^data:image\/png;base64,/)
		expect(readBinary).toHaveBeenCalledWith(adapterPath)
	})

	it('does not resolve paths outside supported mounts', async () => {
		const { app, readBinary } = createApp({})

		await expect(
			resolveResourceDataUrl(app, '/other/example.png', 'image/png'),
		).resolves.toBeUndefined()
		expect(readBinary).not.toHaveBeenCalled()
	})
})
