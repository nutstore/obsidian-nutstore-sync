import { createSignal } from 'solid-js'

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
