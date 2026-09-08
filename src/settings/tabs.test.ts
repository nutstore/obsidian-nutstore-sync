import { describe, expect, it } from 'vitest'
import en from '~/i18n/locales/en.json'
import zh from '~/i18n/locales/zh.json'
import { SETTINGS_TABS } from './tabs'

function getByPath(obj: unknown, path: string): unknown {
	return path
		.split('.')
		.reduce<unknown>(
			(acc, key) =>
				acc && typeof acc === 'object'
					? (acc as Record<string, unknown>)[key]
					: undefined,
			obj,
		)
}

describe('SETTINGS_TABS', () => {
	it('should define sync, ai and troubleshooting tabs in order', () => {
		expect(SETTINGS_TABS.map((tab) => tab.key)).toEqual([
			'sync',
			'ai',
			'troubleshooting',
		])
	})

	it.each(SETTINGS_TABS)(
		'tab "$key" should have i18n text in both en and zh',
		(tab) => {
			const enText = getByPath(en, tab.i18nKey)
			const zhText = getByPath(zh, tab.i18nKey)
			expect(typeof enText).toBe('string')
			expect(typeof zhText).toBe('string')
			if (typeof enText === 'string') expect(enText.trim()).not.toBe('')
			if (typeof zhText === 'string') expect(zhText.trim()).not.toBe('')
		},
	)
})
