import { afterEach, describe, expect, it } from 'vitest'
import { createRoot } from 'solid-js'
import { t as solidT } from '~/components/solid-js/i18n'
import i18n, { resolveI18nTemplate } from './index'

const initialLanguage = i18n.language

afterEach(async () => {
	await i18n.changeLanguage(initialLanguage)
})

describe('unified i18n', () => {
	it('switches between en and zh and synchronizes Solid translator', async () => {
		await i18n.changeLanguage('en')
		expect(i18n.language).toBe('en')
		expect(i18n.resolvedLanguage).toBe('en')
		const enLabel = i18n.t('sync.start')
		expect(solidT('sync.start')).toBe(enLabel)

		await i18n.changeLanguage('zh-CN')
		expect(i18n.language).toBe('zh')
		expect(i18n.resolvedLanguage).toBe('zh')
		const zhLabel = i18n.t('sync.start')
		expect(zhLabel).not.toBe(enLabel)
		expect(solidT('sync.start')).toBe(zhLabel)

		// Unknown locale falls back to English.
		await i18n.changeLanguage('fr-FR')
		expect(i18n.language).toBe('en')
		expect(i18n.t('sync.start')).toBe(enLabel)
	})

	it('interpolates CJK, Emoji and special $ replacement sequences verbatim', () => {
		expect(
			resolveI18nTemplate('File {{path}} failed ({{code}})', {
				path: '笔记/$$price & $& 🌿.md',
				code: 503,
			}),
		).toBe('File 笔记/$$price & $& 🌿.md failed (503)')
	})

	it('tracks language updates reactively inside Solid computations', async () => {
		await i18n.changeLanguage('en')
		const observed: string[] = []
		const dispose = createRoot((cleanup) => {
			observed.push(solidT('sync.cancelled'))
			return cleanup
		})
		await i18n.changeLanguage('zh')
		observed.push(solidT('sync.cancelled'))
		dispose()
		expect(observed[0]).not.toBe(observed[1])
	})
})
