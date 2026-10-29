import { describe, expect, it } from 'vitest'
import { resolveByIntelligentMerge } from './merge-utils'

describe('Unicode boundaries in concurrent merges', () => {
	it.each([
		['shared high surrogate', '😀', '😃', '😄'],
		['shared low surrogate', '𠀀', '𠐀', '𠠀'],
		['supplementary ideographs', '𠀀', '𠀁', '𠀂'],
	])(
		'keeps complete characters when replacing %s',
		async (_name, base, local, remote) => {
			for (const label of ['Status', '状态', 'Status 状态 🧭']) {
				for (let attempt = 0; attempt < 10; attempt++) {
					const result = await resolveByIntelligentMerge({
						baseContentText: `${label}: ${base}\n`,
						localContentText: `${label}: ${local}\n`,
						remoteContentText: `${label}: ${remote}\n`,
					})
					expect(result.success).toBe(true)
					expect([
						`${label}: ${local}${remote}\n`,
						`${label}: ${remote}${local}\n`,
					]).toContain(result.mergedText)
					expect(
						new TextDecoder().decode(
							new TextEncoder().encode(result.mergedText),
						),
					).toBe(result.mergedText)
				}
			}
		},
	)

	it('keeps adjacent symbols intact when one branch removes and the other replaces one', async () => {
		const result = await resolveByIntelligentMerge({
			baseContentText: 'Observation 观察：🌱😀🧭\n',
			localContentText: 'Observation 观察：🌱🧭\n',
			remoteContentText: 'Observation 观察：🌱😄🧭\n',
		})
		expect(result).toEqual({
			success: true,
			mergedText: 'Observation 观察：🌱😄🧭\n',
		})
	})

	it('preserves Unicode edits on separate lines', async () => {
		expect(
			await resolveByIntelligentMerge({
				baseContentText: 'Status 状态：😀\nReview 复核：🌱\n',
				localContentText: 'Status 状态：😃\nReview 复核：🌱\n',
				remoteContentText: 'Status 状态：😀\nReview 复核：🌿\n',
			}),
		).toEqual({
			success: true,
			mergedText: 'Status 状态：😃\nReview 复核：🌿\n',
		})
	})
})
