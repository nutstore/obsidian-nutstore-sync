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
		expect(en.chatbox.ui.actions.runHtmlCode).toBeTruthy()
		expect(en.chatbox.ui.actions.showHtmlCode).toBeTruthy()
		expect(zh.chatbox.ui.actions.runHtmlCode).toBeTruthy()
		expect(zh.chatbox.ui.actions.showHtmlCode).toBeTruthy()
	})
})
