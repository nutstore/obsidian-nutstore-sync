import * as i18n from '@solid-primitives/i18n'
import { createResource, createSignal } from 'solid-js'
import en from './locales/en'
import zh from './locales/zh'

export type Locale = 'zh' | 'en'

export function toLocale(language: string) {
	switch (language.split('-')[0].toLowerCase()) {
		case 'zh':
			return 'zh'
		default:
			return 'en'
	}
}

export const [locale, setLocale] = createSignal<Locale>(
	toLocale(navigator.language),
)

const [dict] = createResource(locale, (locale) => {
	switch (locale) {
		case 'zh':
			return i18n.flatten(zh)
		default:
			return i18n.flatten(en)
	}
})

export const t = i18n.translator(dict)
