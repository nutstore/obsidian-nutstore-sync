import * as i18n from '@solid-primitives/i18n'
import { createResource } from 'solid-js'
import { locale } from '../../../i18n'
import en from './locales/en'
import zh from './locales/zh'

export { locale, setLocale, toLocale, type Locale } from '../../../i18n'

const [dict] = createResource(locale, (locale) => {
	switch (locale) {
		case 'zh':
			return i18n.flatten(zh)
		default:
			return i18n.flatten(en)
	}
})

export const t = i18n.translator(dict)
