import { describe, expect, it } from 'vitest'
import { isFuzzySubsequenceMatch } from './fuzzy-match'

describe('isFuzzySubsequenceMatch', () => {
	it('matches when query characters appear in order with intermediate characters (e.g. ggle -> google)', () => {
		expect(isFuzzySubsequenceMatch('ggle', 'google')).toBe(true)
		expect(isFuzzySubsequenceMatch('GGLE', 'google')).toBe(true)
		expect(isFuzzySubsequenceMatch('ggle', 'GOOGLE')).toBe(true)
		expect(isFuzzySubsequenceMatch('gpt4', 'ns/~openai/gpt-4o-latest')).toBe(
			true,
		)
		expect(isFuzzySubsequenceMatch('csonnet', 'claude-3-7-sonnet')).toBe(true)
	})

	it('ignores whitespace in search query (e.g. "gemini 4" -> "gemini-4-argon")', () => {
		expect(isFuzzySubsequenceMatch('g g l e', 'google')).toBe(true)
		expect(
			isFuzzySubsequenceMatch('gemini 4', 'ns/google/gemini-4-argon'),
		).toBe(true)
		expect(
			isFuzzySubsequenceMatch('claude 5', 'ns/anthropic/claude-haiku-5.5'),
		).toBe(true)
		expect(isFuzzySubsequenceMatch('深度 求索', '深度求索语言模型')).toBe(true)
	})

	it('handles non-matching sequences correctly', () => {
		expect(isFuzzySubsequenceMatch('goglez', 'google')).toBe(false)
		expect(isFuzzySubsequenceMatch('elgg', 'google')).toBe(false)
	})

	it('handles Chinese characters and emojis properly', () => {
		expect(isFuzzySubsequenceMatch('深度', '深度求索语言模型')).toBe(true)
		expect(isFuzzySubsequenceMatch('深索', '深度求索语言模型')).toBe(true)
		expect(isFuzzySubsequenceMatch('🚀turbo', 'ns/语言模型/🚀-turbo-max')).toBe(
			true,
		)
	})

	it('handles empty query and empty target', () => {
		expect(isFuzzySubsequenceMatch('', 'google')).toBe(true)
		expect(isFuzzySubsequenceMatch('   ', 'google')).toBe(true)
		expect(isFuzzySubsequenceMatch('a', '')).toBe(false)
	})
})
