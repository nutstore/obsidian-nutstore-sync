import { describe, expect, it } from 'vitest'
import { isRunnableHtmlCodeBlock } from './chatbox-code-preview'
import en from '~/i18n/locales/en.json'
import zh from '~/i18n/locales/zh.json'

describe('isRunnableHtmlCodeBlock', () => {
	it('matches html code blocks', () => {
		expect(isRunnableHtmlCodeBlock('language-html')).toBe(true)
		expect(isRunnableHtmlCodeBlock('language-html line-numbers')).toBe(true)
		expect(isRunnableHtmlCodeBlock('line-numbers language-html')).toBe(true)
	})

	it('ignores other languages', () => {
		expect(isRunnableHtmlCodeBlock('language-javascript')).toBe(false)
		expect(isRunnableHtmlCodeBlock('language-svg')).toBe(false)
		expect(isRunnableHtmlCodeBlock('language-xhtml')).toBe(false)
		expect(isRunnableHtmlCodeBlock('')).toBe(false)
	})
})

describe('html code preview i18n', () => {
	it('provides run/show labels in both locales', () => {
		const labels = [
			en.chatbox.ui.actions.runHtmlCode,
			en.chatbox.ui.actions.showHtmlCode,
			zh.chatbox.ui.actions.runHtmlCode,
			zh.chatbox.ui.actions.showHtmlCode,
		]
		for (const label of labels) {
			expect(typeof label).toBe('string')
			expect(label.trim()).not.toBe('')
		}
	})
})
