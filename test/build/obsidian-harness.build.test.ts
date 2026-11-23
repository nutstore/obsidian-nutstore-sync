import { describe, expect, it } from 'vitest'
import { buildHarness } from '../../scripts/run-obsidian-integration.mjs'

describe('Obsidian E2E harness bundle isolation', () => {
	it('bundles cleanly with zero production src/ or third-party runtime modules', async () => {
		const result = await buildHarness(undefined, {
			write: false,
			metafile: true,
		})

		expect(result.errors).toEqual([])
		const inputs = Object.keys(result.metafile?.inputs ?? {})
		expect(inputs.length).toBeGreaterThan(0)
		expect(inputs.some((file) => file.startsWith('src/'))).toBe(false)
		expect(inputs.some((file) => file.includes('node_modules/'))).toBe(false)

		const outputBytes = result.outputFiles?.[0]?.contents.byteLength ?? 0
		expect(outputBytes).toBeGreaterThan(1_000)
		// Without bundled production code, the entire E2E harness stays tiny.
		expect(outputBytes).toBeLessThan(100 * 1024)
	})
})
