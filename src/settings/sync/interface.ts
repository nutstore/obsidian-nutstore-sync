import { isNil } from 'es-toolkit/compat'
import { Setting } from 'obsidian'
import i18n from '~/i18n'
import BaseSettings from '../settings.base'

/** Interface preferences kept in the sync tab until a broader general tab exists. */
export default class InterfaceSettings extends BaseSettings {
	readonly name = () => i18n.t('settings.sections.interface')
	readonly showGroupHeading = true

	getSearchTerms(): string[] {
		return [i18n.t('settings.language.name'), i18n.t('settings.language.desc')]
	}

	async display() {
		this.containerEl.empty()
		new Setting(this.containerEl)
			.setName(i18n.t('settings.language.name'))
			.setDesc(i18n.t('settings.language.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('', i18n.t('settings.language.auto'))
					.addOption('zh', '简体中文')
					.addOption('en', 'English')
					.setValue(this.plugin.settings.language || '')
					.onChange(async (value: string) => {
						if (
							value === 'zh' ||
							value === 'en' ||
							value === '' ||
							isNil(value)
						) {
							this.plugin.settings.language = value || undefined
							await this.plugin.settingsService.saveSettings()
							await this.plugin.i18nService.update()
							void this.settings.rerenderIfVisible()
						}
					}),
			)
	}
}
