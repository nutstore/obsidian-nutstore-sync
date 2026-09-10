import { Setting } from 'obsidian'
import {
	getFirstModel,
	getModelById,
	getProviderById,
	listModels,
	listProviders,
} from '~/ai/catalog/config'
import i18n from '~/i18n'
import BaseSettings from '../settings.base'

type SubagentType = 'explorer' | 'memory'

/** Settings for the specialized agents that the chat agent may dispatch. */
export default class SubagentSettingsSection extends BaseSettings {
	readonly name = () => i18n.t('settings.ai.subagents.heading')
	readonly showGroupHeading = true

	getSearchTerms(): string[] {
		return [
			i18n.t('settings.ai.subagents.explorer.name'),
			i18n.t('settings.ai.subagents.explorer.desc'),
			i18n.t('settings.ai.subagents.explorer.model.name'),
			i18n.t('settings.ai.subagents.explorer.model.desc'),
			i18n.t('settings.ai.subagents.memory.name'),
			i18n.t('settings.ai.subagents.memory.desc'),
			i18n.t('settings.ai.subagents.memory.model.name'),
			i18n.t('settings.ai.subagents.memory.model.desc'),
		]
	}

	async display() {
		this.containerEl.empty()
		this.addSettings('explorer')
		this.addSettings('memory')
	}

	private addSettings(type: SubagentType) {
		const config = this.plugin.settings.ai.subagents[type]
		const keys = `settings.ai.subagents.${type}` as const
		new Setting(this.containerEl)
			.setName(i18n.t(`${keys}.name`))
			.setDesc(i18n.t(`${keys}.desc`))
			.addToggle((toggle) =>
				toggle.setValue(config.enabled).onChange(async (enabled) => {
					config.enabled = enabled
					await this.plugin.settingsService.saveSettings()
					void this.display()
				}),
			)
		if (!config.enabled) return

		new Setting(this.containerEl)
			.setName(i18n.t(`${keys}.model.name`))
			.setDesc(i18n.t(`${keys}.model.desc`))
			.addDropdown((dropdown) => {
				dropdown.addOption('', i18n.t('settings.ai.none'))
				for (const provider of listProviders(
					this.plugin.settings.ai.providers,
				)) {
					dropdown.addOption(
						provider.id,
						provider.name || i18n.t('settings.ai.unnamedProvider'),
					)
				}
				dropdown
					.setValue(config.model?.providerId || '')
					.onChange(async (providerId) => {
						if (!providerId) {
							config.model = undefined
						} else {
							const provider = getProviderById(
								this.plugin.settings.ai.providers,
								providerId,
							)
							const model =
								getModelById(provider, config.model?.modelId) ||
								getFirstModel(provider)
							config.model = model
								? { providerId, modelId: model.id }
								: undefined
						}
						await this.plugin.settingsService.saveSettings()
						void this.display()
					})
			})
			.addDropdown((dropdown) => {
				const provider = getProviderById(
					this.plugin.settings.ai.providers,
					config.model?.providerId,
				)
				dropdown.addOption('', i18n.t('settings.ai.none'))
				for (const model of listModels(provider)) {
					dropdown.addOption(
						model.id,
						model.name || i18n.t('settings.ai.unnamedModel'),
					)
				}
				dropdown
					.setValue(config.model?.modelId || '')
					.setDisabled(!provider)
					.onChange(async (modelId) => {
						const providerId = config.model?.providerId
						config.model =
							providerId && modelId ? { providerId, modelId } : undefined
						await this.plugin.settingsService.saveSettings()
					})
			})
	}
}
