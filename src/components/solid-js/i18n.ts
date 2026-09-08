import * as i18n from '@solid-primitives/i18n'
import en from '~/i18n/locales/en.json'
import zh from '~/i18n/locales/zh.json'

type ComponentMessages = typeof en

const messagesByLocale: Record<Locale, ComponentMessages> = {
	en,
	zh: zh,
}

type ComponentDict = i18n.Flatten<ComponentMessages>

type Locale = 'zh' | 'en'

function toLocale(language: string): Locale {
	switch (language.split('-')[0].toLowerCase()) {
		case 'zh':
			return 'zh'
		default:
			return 'en'
	}
}

const dict: ComponentDict = i18n.flatten(
	messagesByLocale[
		toLocale(typeof navigator === 'undefined' ? 'en' : navigator.language)
	],
)

export const t = i18n.translator(() => dict, i18n.resolveTemplate)
