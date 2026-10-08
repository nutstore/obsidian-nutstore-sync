import { Notice, Setting } from 'obsidian'
import { normalizeMemoryNotePath } from '~/ai/memory/memory-note'
import i18n from '~/i18n'
import BaseSettings from '../settings.base'

/** Memory stays in the plugin directory; these controls configure and view it. */
export default class MemorySettingsSection extends BaseSettings {
	readonly name = () => i18n.t('settings.ai.memory.heading')
	readonly showGroupHeading = true

	getSearchTerms(): string[] {
		return [
			i18n.t('settings.ai.memory.heading'),
			i18n.t('settings.ai.memory.enabled.name'),
			i18n.t('settings.ai.memory.enabled.desc'),
			i18n.t('settings.ai.memory.path.name'),
			i18n.t('settings.ai.memory.path.desc'),
		]
	}

	async display() {
		this.containerEl.empty()
		const memory = this.plugin.settings.ai.memory
		new Setting(this.containerEl)
			.setName(i18n.t('settings.ai.memory.enabled.name'))
			.setDesc(i18n.t('settings.ai.memory.enabled.desc'))
			.addToggle((toggle) =>
				toggle.setValue(memory.enabled).onChange(async (enabled) => {
					memory.enabled = enabled
					await this.plugin.settingsService.saveSettings()
				}),
			)

		new Setting(this.containerEl)
			.setName(i18n.t('settings.ai.memory.path.name'))
			.setDesc(i18n.t('settings.ai.memory.path.desc'))
			.addText((text) => {
				text.setValue(memory.path)
				// Validate on commit rather than per keystroke.
				text.inputEl.addEventListener('change', () => {
					const path = normalizeMemoryNotePath(text.getValue())
					if (!path) {
						new Notice(i18n.t('settings.ai.memory.path.invalid'))
						text.setValue(memory.path)
						return
					}
					text.setValue(path)
					if (path === memory.path) return
					memory.path = path
					void this.plugin.settingsService.saveSettings()
				})
			})
			.addButton((button) =>
				button
					.setButtonText(i18n.t('settings.ai.memory.open'))
					.onClick(async () => {
						this.app.setting?.close()
						await this.plugin.memoryService.openNote()
					}),
			)
	}
}
