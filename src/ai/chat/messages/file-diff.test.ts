import { describe, expect, it } from 'vitest'
import { buildLineDiff } from './file-diff'

function numberedLines(count: number) {
	return Array.from({ length: count }, (_, index) => `line ${index + 1}`)
}

describe('buildLineDiff', () => {
	it('shows two context lines around a single changed line', () => {
		const before = numberedLines(12)
		const after = [...before]
		after[9] = 'changed 10'

		const [hunk] = buildLineDiff(before.join('\n'), after.join('\n'))
		expect(hunk).toMatchObject({
			oldStart: 8,
			oldCount: 5,
			newStart: 8,
			newCount: 5,
		})
		expect(hunk.lines.map((line) => line.kind)).toEqual([
			'context',
			'context',
			'remove',
			'add',
			'context',
			'context',
		])
	})

	it('keeps distant changed ranges in separate hunks', () => {
		const before = numberedLines(205)
		const after = [...before]
		after[9] = 'changed 10'
		for (let line = 100; line <= 200; line += 1) {
			after[line - 1] = `changed ${line}`
		}

		const hunks = buildLineDiff(before.join('\n'), after.join('\n'))
		expect(hunks).toHaveLength(2)
		expect(hunks.map(({ oldStart, oldCount }) => [oldStart, oldCount])).toEqual(
			[
				[8, 5],
				[98, 105],
			],
		)
	})

	it('marks changed characters within a replaced line', () => {
		const [hunk] = buildLineDiff('const value = old', 'const value = new')
		const [removed, added] = hunk.lines

		expect(removed.segments).toEqual([
			{ text: 'const value = ', changed: false },
			{ text: 'old', changed: true },
		])
		expect(added.segments).toEqual([
			{ text: 'const value = ', changed: false },
			{ text: 'new', changed: true },
		])
	})

	it('keeps inline diff alignment when one line expands into multiple lines', () => {
		const [hunk] = buildLineDiff(
			'const value = oldValue',
			['const value =', '  newValue'].join('\n'),
		)
		const [removed, firstAdded, secondAdded] = hunk.lines

		expect(removed.segments).toEqual([
			{ text: 'const value =', changed: false },
			{ text: ' old', changed: true },
			{ text: 'Value', changed: false },
		])
		expect(firstAdded.segments).toEqual([
			{ text: 'const value =', changed: false },
		])
		expect(secondAdded.segments).toEqual([
			{ text: '  new', changed: true },
			{ text: 'Value', changed: false },
		])
	})

	it('aligns inline changes by content when a replacement adds a leading line', () => {
		const [hunk] = buildLineDiff(
			['alpha old', 'beta old', 'gamma old'].join('\n'),
			['inserted', 'alpha new', 'beta new', 'gamma new'].join('\n'),
		)
		const removed = hunk.lines.filter((line) => line.kind === 'remove')
		const added = hunk.lines.filter((line) => line.kind === 'add')

		expect(removed[0].segments).toEqual([
			{ text: 'alpha ', changed: false },
			{ text: 'old', changed: true },
		])
		expect(added[1].segments).toEqual([
			{ text: 'alpha ', changed: false },
			{ text: 'new', changed: true },
		])
	})

	it('aligns inline changes after a deleted leading line', () => {
		const [hunk] = buildLineDiff(
			['removed', 'alpha old', 'beta old'].join('\n'),
			['alpha new', 'beta new'].join('\n'),
		)
		const removed = hunk.lines.filter((line) => line.kind === 'remove')
		const added = hunk.lines.filter((line) => line.kind === 'add')

		expect(removed[1].segments).toEqual([
			{ text: 'alpha ', changed: false },
			{ text: 'old', changed: true },
		])
		expect(added[0].segments).toEqual([
			{ text: 'alpha ', changed: false },
			{ text: 'new', changed: true },
		])
	})

	it('keeps alignment around an inserted line in the middle of a replacement', () => {
		const [hunk] = buildLineDiff(
			['alpha old', 'beta old', 'gamma old'].join('\n'),
			['alpha new', 'inserted', 'beta new', 'gamma new'].join('\n'),
		)
		const removed = hunk.lines.filter((line) => line.kind === 'remove')
		const added = hunk.lines.filter((line) => line.kind === 'add')

		expect(removed[1].segments).toEqual([
			{ text: 'beta ', changed: false },
			{ text: 'old', changed: true },
		])
		expect(added[2].segments).toEqual([
			{ text: 'beta ', changed: false },
			{ text: 'new', changed: true },
		])
	})

	it('preserves ordered matches around repeated lines', () => {
		const [hunk] = buildLineDiff(
			['item old', 'item old', 'tail old'].join('\n'),
			['item new', 'inserted', 'item new', 'tail new'].join('\n'),
		)
		const removed = hunk.lines.filter((line) => line.kind === 'remove')
		const added = hunk.lines.filter((line) => line.kind === 'add')

		expect(removed.map((line) => line.text)).toEqual([
			'item old',
			'item old',
			'tail old',
		])
		expect(added.map((line) => line.text)).toEqual([
			'item new',
			'inserted',
			'item new',
			'tail new',
		])
		expect(added[2].segments).toEqual([
			{ text: 'item ', changed: false },
			{ text: 'new', changed: true },
		])
	})

	it('represents a removed trailing newline as a line change', () => {
		const [hunk] = buildLineDiff('alpha\n', 'alpha')

		expect(hunk.lines).toMatchObject([
			{ kind: 'remove', oldLine: 1, text: 'alpha' },
			{ kind: 'add', newLine: 1, text: 'alpha' },
		])
	})

	it('preserves content when two lines are merged', () => {
		const [hunk] = buildLineDiff('alpha\nbeta', 'alphabeta')

		expect(hunk.lines).toMatchObject([
			{ kind: 'remove', oldLine: 1, text: 'alpha' },
			{ kind: 'remove', oldLine: 2, text: 'beta' },
			{ kind: 'add', newLine: 1, text: 'alphabeta' },
		])
	})

	it('preserves content when one line is split', () => {
		const [hunk] = buildLineDiff('alphabeta', 'alpha\nbeta')

		expect(hunk.lines).toMatchObject([
			{ kind: 'remove', oldLine: 1, text: 'alphabeta' },
			{ kind: 'add', newLine: 1, text: 'alpha' },
			{ kind: 'add', newLine: 2, text: 'beta' },
		])
	})
})
