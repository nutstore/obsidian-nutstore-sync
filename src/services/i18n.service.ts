import i18n from '~/i18n'
import { BaseService } from './service.interface'
import logger from '~/utils/logger'
import NutstorePlugin from '..'

export default class I18nService extends BaseService {
	constructor(private plugin: NutstorePlugin) {
		super()
	}

	override onload() {
		return this.update()
	}

	update = async () => {
		try {
			if (this.plugin.settings.language) {
				i18n.changeLanguage(this.plugin.settings.language.toLowerCase())
			} else {
				const code = navigator.language.split('-')[0]
				i18n.changeLanguage(code.toLowerCase())
			}
		} catch (e) {
			logger.error(e)
		}
	}
}
