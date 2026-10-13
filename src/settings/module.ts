import { Setting } from 'obsidian'
import i18n from '~/i18n'
import { ModuleState } from '~/modules/lifecycle'
import BaseSettings from './settings.base'

export default class ModuleSettings extends BaseSettings {
	module: 'sync' | 'ai' = 'sync'
	readonly name = () =>
		i18n.t(
			this.module === 'sync' ? 'settings.modules.sync' : 'settings.modules.ai',
		)
	readonly showGroupHeading = false

	getSearchTerms() {
		return [this.name(), i18n.t('settings.modules.description')]
	}

	async display() {
		this.containerEl.empty()
		const key = this.module === 'sync' ? 'syncModule' : 'aiModule'
		new Setting(this.containerEl)
			.setName(this.name())
			.setDesc(i18n.t('settings.modules.description'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings[key] === ModuleState.Enabled)
					.onChange(async (enabled) => {
						toggle.setDisabled(true)
						try {
							this.plugin.settings[key] = enabled
								? ModuleState.Enabled
								: ModuleState.Disabled
							await this.plugin.settingsService.saveSettings()
							await this.settings.rerenderIfVisible()
						} finally {
							toggle.setDisabled(false)
						}
					}),
			)
	}
}
