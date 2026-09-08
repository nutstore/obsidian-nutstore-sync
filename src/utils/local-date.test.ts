import { describe, expect, it } from 'vitest'
import { formatLocalDate, formatLocalTimestampForFilename } from './local-date'

describe('local date formatting', () => {
	it('formats local calendar fields without converting to UTC', () => {
		const localDate = new Date(2026, 1, 10, 0, 30, 4, 5)

		expect(formatLocalDate(localDate)).toBe('2026-02-10')
		expect(formatLocalTimestampForFilename(localDate)).toBe(
			'2026-02-10T00-30-04-005',
		)
	})
})
