import { describe, expect, it } from 'vitest'
import {
	formatLocalDate,
	formatLocalTimestamp,
	formatLocalTimestampForFilename,
} from './local-date'

/** Local wall-clock fields, stable in any timezone because the Date is local. */
function localFields(date: Date) {
	return {
		year: date.getFullYear(),
		month: date.getMonth() + 1,
		day: date.getDate(),
		hours: date.getHours(),
		minutes: date.getMinutes(),
		seconds: date.getSeconds(),
	}
}

function pad(value: number, length = 2) {
	return String(value).padStart(length, '0')
}

describe('local date formatting', () => {
	it('formats local calendar fields without converting to UTC', () => {
		const localDate = new Date(2026, 1, 10, 0, 30, 4, 5)

		expect(formatLocalDate(localDate)).toBe('2026-02-10')
		expect(formatLocalTimestampForFilename(localDate)).toBe(
			'2026-02-10T00-30-04-005',
		)
	})

	describe('formatLocalTimestamp', () => {
		it('renders the local date and time as YYYY-MM-DD HH:mm:ss', () => {
			// 00:30 local: a UTC conversion would land on the previous day in
			// every timezone east of UTC, so this case catches that bug class.
			const localDate = new Date(2026, 1, 10, 0, 30, 4)

			expect(formatLocalTimestamp(localDate)).toBe('2026-02-10 00:30:04')
		})

		it('pads month, day, hour, minute and second to two digits', () => {
			const localDate = new Date(2026, 0, 2, 3, 4, 5)

			expect(formatLocalTimestamp(localDate)).toBe('2026-01-02 03:04:05')
		})

		it('builds the expected value from local clock getters', () => {
			const localDate = new Date(2026, 6, 4, 9, 8, 7)
			const fields = localFields(localDate)

			const expected = `${pad(fields.year, 4)}-${pad(fields.month)}-${pad(
				fields.day,
			)} ${pad(fields.hours)}:${pad(fields.minutes)}:${pad(fields.seconds)}`

			expect(formatLocalTimestamp(localDate)).toBe(expected)
			expect(formatLocalTimestamp(localDate)).toBe('2026-07-04 09:08:07')
		})

		it('keeps the local date at both day boundaries', () => {
			expect(formatLocalTimestamp(new Date(2025, 11, 31, 23, 59, 59))).toBe(
				'2025-12-31 23:59:59',
			)
			expect(formatLocalTimestamp(new Date(2026, 0, 1, 0, 0, 0))).toBe(
				'2026-01-01 00:00:00',
			)
		})

		it('matches the documented pattern and drops milliseconds', () => {
			const localDate = new Date(2026, 2, 9, 12, 34, 56, 789)
			const timestamp = formatLocalTimestamp(localDate)

			expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
			// Milliseconds are intentionally not part of this human-facing format.
			expect(timestamp).toBe('2026-03-09 12:34:56')
		})

		it('agrees with formatLocalDate on the calendar part', () => {
			const localDate = new Date(2026, 10, 22, 6, 7, 8)

			expect(formatLocalTimestamp(localDate)).toBe(
				`${formatLocalDate(localDate)} 06:07:08`,
			)
		})

		it('pads a year earlier than 1000 back to four digits', () => {
			const localDate = new Date(999, 0, 5, 1, 2, 3)

			expect(formatLocalTimestamp(localDate)).toBe('0999-01-05 01:02:03')
		})
	})
})
