import { describe, expect, it } from 'vitest'
import { formatDuration } from './utils'

describe('formatDuration', () => {
	it('uses compact stable units', () => {
		expect(formatDuration(320)).toBe('320ms')
		expect(formatDuration(8_900)).toBe('8s')
		expect(formatDuration(68_000)).toBe('1m 08s')
		expect(formatDuration(3_720_000)).toBe('1h 02m')
	})
})
