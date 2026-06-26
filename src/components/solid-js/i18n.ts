import * as i18n from '@solid-primitives/i18n'
import { createMemo, createSignal } from 'solid-js'
import en from '~/i18n/locales/en.json'
import zh from '~/i18n/locales/zh.json'

type ComponentMessages = typeof en

const messagesByLocale: Record<Locale, ComponentMessages> = {
	en,
	zh: zh as ComponentMessages,
}

type ComponentDict = i18n.Flatten<ComponentMessages>

export type Locale = 'zh' | 'en'

export function toLocale(language: string): Locale {
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

const dict = createMemo<ComponentDict>(() =>
	i18n.flatten(messagesByLocale[locale()]),
)

export const t = i18n.translator(dict, i18n.resolveTemplate)
