import { describe, expect, it, vi } from 'vitest'
import { editMemoryNote, listMemoryEntries } from './memory-note'

// Exercise ambiguity deliberately instead of relying on a natural hash collision.
vi.mock('ohash', () => ({ sha256: () => '012345abcdef'.repeat(6) }))

const FIRST = 'Prefers metric units 偏好公制单位 📏'
const SECOND = 'Weekly review 每周复盘 🗓️'

describe('memory hash ambiguity', () => {
	it('rejects a hash matching different text before applying any part of the edit', () => {
		const note = `${FIRST}\n${SECOND}\n`
		const reference = listMemoryEntries(note)[0].id
		expect(() =>
			editMemoryNote(note, {
				forget: [reference],
				remember: ['Drafts in inbox 草稿收件箱 📥'],
			}),
		).toThrow('ambiguous memory IDs, nothing was changed')
	})

	it('treats identical lines as copies rather than a collision', () => {
		const note = `${FIRST}\n${FIRST}\n`
		const result = editMemoryNote(note, {
			forget: [listMemoryEntries(note)[0].id],
			remember: [],
		})
		expect(result.content).toBe('')
		expect(result.forgotten).toEqual([FIRST])
	})
})
