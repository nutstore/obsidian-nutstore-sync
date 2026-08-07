import { describe, expect, it } from 'vitest'

import { classTokens } from './class-tokens'

describe('classTokens', () => {
	it.each([
		[
			'splits an English utility group',
			':uno: flex items-center',
			[':uno:', 'flex', 'items-center'],
		],
		['拆分中文界面的工具类组', ':uno: hidden', [':uno:', 'hidden']],
	])('%s', (_, className, expected) => {
		expect(classTokens(className)).toEqual(expected)
	})

	it('ignores neutral whitespace between tokens', () => {
		expect(classTokens('  :uno:  ', 'max-w-full\ttruncate')).toEqual([
			':uno:',
			'max-w-full',
			'truncate',
		])
	})
})
