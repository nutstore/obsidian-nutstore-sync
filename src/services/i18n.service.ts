import i18n from '~/i18n'
import { useSettings } from '~/settings'
import logger from '~/utils/logger'
import NutstorePlugin from '..'

export default class I18nService {
	constructor(private plugin: NutstorePlugin) {
		this.update()
	}

	update = async () => {
		try {
			const settings = await useSettings()
			if (settings.language) {
				i18n.changeLanguage(settings.language.toLowerCase())
			} else {
				const code = navigator.language.split('-')[0]
				i18n.changeLanguage(code.toLowerCase())
			}
		} catch (e) {
			logger.error(e)
		}
	}
}
