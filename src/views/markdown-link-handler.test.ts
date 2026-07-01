import { describe, expect, it } from 'vitest'
import {
	resolveMarkdownLinkAction,
	resolveMarkdownSourcePath,
} from './markdown-link-handler'

describe('resolveMarkdownSourcePath', () => {
	it('returns the active file path when present', () => {
		expect(resolveMarkdownSourcePath('notes/current.md')).toBe(
			'notes/current.md',
		)
	})

	it('normalizes empty values to an empty string', () => {
		expect(resolveMarkdownSourcePath('')).toBe('')
		expect(resolveMarkdownSourcePath('   ')).toBe('')
		expect(resolveMarkdownSourcePath(undefined)).toBe('')
	})
})

describe('resolveMarkdownLinkAction', () => {
	it('treats internal links as vault links', () => {
		expect(
			resolveMarkdownLinkAction({
				href: 'Target note',
				classNames: ['internal-link'],
			}),
		).toEqual({
			type: 'internal',
			linktext: 'Target note',
		})
	})
})
