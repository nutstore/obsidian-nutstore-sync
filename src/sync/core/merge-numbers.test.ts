import { describe, expect, it } from 'vitest'
import { resolveByIntelligentMerge } from './merge-utils'

async function merge(base: string, local: string, remote: string) {
	const result = await resolveByIntelligentMerge({
		baseContentText: base,
		localContentText: local,
		remoteContentText: remote,
	})
	expect(result.success).toBe(true)
	return result.isIdentical ? local : result.mergedText
}

describe('concurrent numeric edits', () => {
	it.each([
		['100', '150', '120'],
		['100', '150', '102'],
		['100', '1000', '200'],
		['100', '50', '10'],
		['10.25', '12.25', '10.75'],
		['-10.25', '-12.25', '-10.75'],
		['1e3', '2e3', '1e4'],
	])(
		'keeps the complete local value for %s → %s / %s',
		async (base, local, remote) => {
			for (const label of ['Quantity', '数量', 'Quantity 数量 🌱']) {
				for (let attempt = 0; attempt < 10; attempt++) {
					expect(
						await merge(
							`${label}: ${base}\n`,
							`${label}: ${local}\n`,
							`${label}: ${remote}\n`,
						),
					).toBe(`${label}: ${local}\n`)
				}
			}
		},
	)

	it('retains independent numeric edits on the same line', async () => {
		expect(
			await merge(
				'数量 🌱: 100; price: 20\n',
				'数量 🌱: 150; price: 20\n',
				'数量 🌱: 100; price: 25\n',
			),
		).toBe('数量 🌱: 150; price: 25\n')
	})

	it('distinguishes identical numbers at different baseline positions', async () => {
		expect(
			await merge(
				'Count 数量 🌱: 100; limit: 100\n',
				'Count 数量 🌱: 150; limit: 100\n',
				'Count 数量 🌱: 120; limit: 200\n',
			),
		).toBe('Count 数量 🌱: 150; limit: 200\n')
	})

	it('deduplicates equal numeric replacements while retaining unrelated edits', async () => {
		expect(
			await merge(
				'Count 数量 🌱: 100; note: draft\n',
				'Count 数量 🌱: 150; note: draft\n',
				'Count 数量 🌱: 150; note: reviewed\n',
			),
		).toBe('Count 数量 🌱: 150; note: reviewed\n')
	})

	it('preserves a remote one-sided number change', async () => {
		expect(
			await merge(
				'Count 数量 🌱: 100; review: pending\n',
				'Count 数量 🌱: 100; review: done\n',
				'Count 数量 🌱: 120; review: pending\n',
			),
		).toBe('Count 数量 🌱: 120; review: done\n')
	})

	it('does not treat unrelated inserted numbers without a baseline as the same value', async () => {
		const result = await merge(
			'',
			'Quantity 数量 🌱: 150\n',
			'Limit 上限 🧭: 120\n',
		)
		expect(result).toContain('Quantity 数量 🌱: 150')
		expect(result).toContain('Limit 上限 🧭: 120')
	})
})
