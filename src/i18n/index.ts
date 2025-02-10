import i18n from 'i18next'
import en from './locales/en'
import zh from './locales/zh'

const defaultNS = 'translation'
const resources = {
	zh: {
		translation: zh,
	},
	en: {
		translation: en,
	},
} as const

declare module 'i18next' {
	interface CustomTypeOptions {
		defaultNS: 'translation'
		resources: (typeof resources)['en']
	}
}

i18n.init({
	ns: ['translation'],
	defaultNS,
	resources,
	fallbackLng: 'en',
})

export default i18n
