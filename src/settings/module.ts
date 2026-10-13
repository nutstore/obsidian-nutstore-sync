import { Setting } from 'obsidian'
import i18n from '~/i18n'
import { ModuleState } from '~/modules/lifecycle'
import type { FeatureModule } from '.'
import BaseSettings from './settings.base'

export default class ModuleSettings extends BaseSettings {
	module: FeatureModule = 'sync'
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
		new Setting(this.containerEl)
			.setName(this.name())
			.setDesc(i18n.t('settings.modules.description'))
			.addToggle((toggle) =>
				toggle
					.setValue(
						this.plugin.localSettings.modules[this.module] ===
							ModuleState.Enabled,
					)
					.onChange(async (enabled) => {
						toggle.setDisabled(true)
						try {
							await this.plugin.settingsService.setModuleState(
								this.module,
								enabled ? ModuleState.Enabled : ModuleState.Disabled,
							)
							await this.settings.rerenderIfVisible()
						} finally {
							toggle.setDisabled(false)
						}
					}),
			)
	}
}
