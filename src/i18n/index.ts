import * as solidI18n from '@solid-primitives/i18n'
import { createSignal } from 'solid-js'
import en from './locales/en.json'
import zh from './locales/zh.json'

export type Locale = 'en' | 'zh'
export type Messages = typeof en
export type FlatMessages = solidI18n.Flatten<Messages>

function toLocale(language: string | undefined): Locale {
	if (!language) return 'en'
	return language.split('-')[0].toLowerCase() === 'zh' ? 'zh' : 'en'
}

const flatEn: FlatMessages = solidI18n.flatten(en)
const flatZh: FlatMessages = {
	...flatEn,
	...solidI18n.flatten(zh),
}

const dictionaries: Record<Locale, FlatMessages> = {
	en: flatEn,
	zh: flatZh,
}

const initialLocale = toLocale(
	typeof navigator === 'undefined' ? 'en' : navigator.language,
)

const [locale, setLocale] = createSignal<Locale>(initialLocale)

/**
 * Replaces `{{key}}` placeholders using a callback so `$` sequences in dynamic
 * paths or error messages are inserted verbatim.
 */
export function resolveI18nTemplate(
	template: string,
	args?: solidI18n.BaseTemplateArgs,
): string {
	if (!args) return template
	return template.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (match, key: string) => {
		if (!Object.prototype.hasOwnProperty.call(args, key)) return match
		const value = args[key]
		return value === undefined || value === null ? '' : String(value)
	})
}

const translateRaw = solidI18n.translator(
	() => dictionaries[locale()],
	resolveI18nTemplate,
)

export const t: solidI18n.Translator<FlatMessages> = ((
	path: keyof FlatMessages,
	...args: unknown[]
) => {
	const value = (translateRaw as (...params: unknown[]) => unknown)(
		path,
		...args,
	)
	return value === undefined ? String(path) : value
}) as unknown as solidI18n.Translator<FlatMessages>

const i18n = {
	get language(): Locale {
		return locale()
	},
	get resolvedLanguage(): Locale {
		return locale()
	},
	changeLanguage(language: string): Promise<void> {
		setLocale(toLocale(language))
		return Promise.resolve()
	},
	t,
}

export default i18n
