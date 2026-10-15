import { describe, expect, it } from 'vitest'
import { formatTokenCount, parseTokenCount } from './token-format'

describe('token-format', () => {
	describe('parseTokenCount', () => {
		it('parses pure numbers and strings with digits', () => {
			expect(parseTokenCount(65536)).toBe(65536)
			expect(parseTokenCount('65536')).toBe(65536)
			expect(parseTokenCount(0)).toBe(0)
			expect(parseTokenCount('0')).toBe(0)
		})

		it('parses numbers with commas or underscores', () => {
			expect(parseTokenCount('1,048,576')).toBe(1048576)
			expect(parseTokenCount('65,536')).toBe(65536)
			expect(parseTokenCount('128_000')).toBe(128000)
		})

		it('parses k/K and m/M shorthand notation', () => {
			expect(parseTokenCount('10k')).toBe(10000)
			expect(parseTokenCount('10K')).toBe(10000)
			expect(parseTokenCount('128k')).toBe(128000)
			expect(parseTokenCount('1M')).toBe(1000000)
			expect(parseTokenCount('1m')).toBe(1000000)
			expect(parseTokenCount('1.5M')).toBe(1500000)
			expect(parseTokenCount('2M')).toBe(2000000)
		})

		it('parses binary prefixes like ki and mi', () => {
			expect(parseTokenCount('64ki')).toBe(65536)
			expect(parseTokenCount('1mi')).toBe(1048576)
		})

		it('handles whitespace and empty strings', () => {
			expect(parseTokenCount('')).toBe(0)
			expect(parseTokenCount('   ')).toBe(0)
			expect(parseTokenCount('  10k  ')).toBe(10000)
			expect(parseTokenCount(undefined)).toBeUndefined()
			expect(parseTokenCount(null)).toBeUndefined()
		})

		it('returns undefined for invalid inputs', () => {
			expect(parseTokenCount('abc')).toBeUndefined()
			expect(parseTokenCount('-10k')).toBeUndefined()
			expect(parseTokenCount(-100)).toBeUndefined()
			expect(parseTokenCount('10xyz')).toBeUndefined()
		})
	})

	describe('formatTokenCount', () => {
		it('formats numbers with comma separators', () => {
			expect(formatTokenCount(1048576)).toBe('1,048,576')
			expect(formatTokenCount(65536)).toBe('65,536')
			expect(formatTokenCount(128000)).toBe('128,000')
			expect(formatTokenCount(0)).toBe('')
			expect(formatTokenCount(undefined)).toBe('')
		})
	})
})
