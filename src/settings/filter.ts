import { Setting } from 'obsidian'
import FilterEditorModal from '~/components/FilterEditorModal'
import i18n from '~/i18n'
import BaseSettings from './settings.base'

export default class FilterSettings extends BaseSettings {
	async display() {
		this.containerEl.empty()
		new Setting(this.containerEl)
			.setName(i18n.t('settings.sections.filters'))
			.setHeading()

		// Inclusion
		new Setting(this.containerEl)
			.setName(i18n.t('settings.filters.include.name'))
			.setDesc(i18n.t('settings.filters.include.desc'))
			.addButton((button) => {
				button.setButtonText(i18n.t('settings.filters.edit')).onClick(() => {
					new FilterEditorModal(
						this.plugin,
						this.plugin.settings.filterRules.inclusionRules,
						async (filters) => {
							this.plugin.settings.filterRules.inclusionRules = filters
							await this.plugin.saveSettings()
							this.display()
						},
					).open()
				})
			})

		// Exclusion
		new Setting(this.containerEl)
			.setName(i18n.t('settings.filters.exclude.name'))
			.setDesc(i18n.t('settings.filters.exclude.desc'))
			.addButton((button) => {
				button.setButtonText(i18n.t('settings.filters.edit')).onClick(() => {
					new FilterEditorModal(
						this.plugin,
						this.plugin.settings.filterRules.exclusionRules,
						async (filters) => {
							this.plugin.settings.filterRules.exclusionRules = filters
							await this.plugin.saveSettings()
							this.display()
						},
					).open()
				})
			})
	}
}
