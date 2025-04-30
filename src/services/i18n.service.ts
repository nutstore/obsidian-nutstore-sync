import { getLanguage } from 'obsidian'
import i18n from '~/i18n'
import NutstorePlugin from '..'

export default class I18nService {
	constructor(private plugin: NutstorePlugin) {
		this.update()
		this.plugin.registerInterval(window.setInterval(this.update, 60000))
	}

	update = () => {
		const code = getLanguage().split('-')[0]
		i18n.changeLanguage(code)
	}
}
