import { Setting } from 'obsidian'
import i18n from '~/i18n'
import { ChatboxLocation, SessionAppOpenMode } from '~/settings'
import BaseSettings from '../settings.base'

export default class AIPreferencesSettings extends BaseSettings {
	readonly name = () => i18n.t('settings.ai.preferences')
	readonly showGroupHeading = true

	getSearchTerms(): string[] {
		return [
			i18n.t('settings.ai.chatboxLocation.name'),
			i18n.t('settings.ai.chatboxLocation.desc'),
			i18n.t('settings.ai.sessionAppOpenMode.name'),
			i18n.t('settings.ai.sessionAppOpenMode.desc'),
		]
	}

	async display() {
		this.containerEl.empty()

		new Setting(this.containerEl)
			.setName(i18n.t('settings.ai.chatboxLocation.name'))
			.setDesc(i18n.t('settings.ai.chatboxLocation.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption(
						ChatboxLocation.Sidebar,
						i18n.t('settings.ai.chatboxLocation.sidebar'),
					)
					.addOption(
						ChatboxLocation.Editor,
						i18n.t('settings.ai.chatboxLocation.editor'),
					)
					.setValue(this.plugin.localSettings.ai.chatboxLocation)
					.onChange(async (value) => {
						const location = Object.values(ChatboxLocation).find(
							(location) => String(location) === value,
						)
						if (!location) return
						this.plugin.localSettings.ai.chatboxLocation = location
						await this.plugin.settingsService.saveLocalSettings()
					}),
			)

		new Setting(this.containerEl)
			.setName(i18n.t('settings.ai.sessionAppOpenMode.name'))
			.setDesc(i18n.t('settings.ai.sessionAppOpenMode.desc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption(
						SessionAppOpenMode.Automatic,
						i18n.t('settings.ai.sessionAppOpenMode.automatic'),
					)
					.addOption(
						SessionAppOpenMode.Manual,
						i18n.t('settings.ai.sessionAppOpenMode.manual'),
					)
					.setValue(this.plugin.localSettings.ai.sessionAppOpenMode)
					.onChange(async (value) => {
						const mode = Object.values(SessionAppOpenMode).find(
							(mode) => String(mode) === value,
						)
						if (!mode) return
						this.plugin.localSettings.ai.sessionAppOpenMode = mode
						await this.plugin.settingsService.saveLocalSettings()
					}),
			)
	}
}
