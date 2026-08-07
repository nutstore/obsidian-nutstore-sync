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

	it('preserves non-ASCII internal link paths from rendered markdown', () => {
		expect(
			resolveMarkdownLinkAction({
				href: '示例目录/测试笔记：中文标题.md',
				datasetHref: '示例目录/测试笔记：中文标题.md',
				classNames: ['internal-link'],
			}),
		).toEqual({
			type: 'internal',
			linktext: '示例目录/测试笔记：中文标题.md',
		})
	})

	it('extracts the provider id from the provider editor protocol', () => {
		expect(
			resolveMarkdownLinkAction({
				href: 'obsidian://nutstore-sync/modal/provider-edit?providerId=openai%20compatible',
			}),
		).toEqual({
			type: 'protocol',
			href: 'obsidian://nutstore-sync/modal/provider-edit?providerId=openai%20compatible',
			providerId: 'openai compatible',
		})
	})
})
