import i18n from '~/i18n'

export function updateLanguage(
	locale = navigator.language.toLowerCase().split('-')[0],
) {
	return i18n.changeLanguage(locale)
}
