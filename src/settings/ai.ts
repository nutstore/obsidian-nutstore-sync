import { Notice, Setting } from 'obsidian'
import {
	getFirstModel,
	getModelById,
	getProviderById,
	listModels,
	listProviders,
	sanitizeDefaultSelections,
	sanitizeProviders,
} from '~/ai/catalog/config'
import ProvidersManagerModal from '~/components/ProvidersManagerModal'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import BaseSettings from './settings.base'

export default class AISettings extends BaseSettings {
	async display() {
		this.containerEl.empty()

		new Setting(this.containerEl)
			.setName(i18n.t('settings.sections.ai'))
			.setHeading()

		new Setting(this.containerEl)
			.setName(i18n.t('settings.ai.providers.name'))
			.setDesc(
				i18n.t('settings.ai.providers.summary', {
					count: this.listUserManagedProviders().length,
				}),
			)
			.addButton((button) =>
				button
					.setButtonText(i18n.t('settings.ai.providers.manage'))
					.onClick(() => {
						new ProvidersManagerModal(this.plugin, async () => {
							await this.persist(false)
							this.display()
						}).open()
					}),
			)

		new Setting(this.containerEl)
			.setName(i18n.t('settings.ai.defaultProvider.name'))
			.setDesc(i18n.t('settings.ai.defaultProvider.desc'))
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
					.setValue(this.plugin.settings.ai.defaultModel?.providerId || '')
					.onChange(async (value) => {
						if (!value) {
							this.plugin.settings.ai.defaultModel = undefined
						} else {
							const provider = getProviderById(
								this.plugin.settings.ai.providers,
								value,
							)
							const currentModelId =
								this.plugin.settings.ai.defaultModel?.modelId
							const model =
								getModelById(provider, currentModelId) ||
								getFirstModel(provider)
							this.plugin.settings.ai.defaultModel = model
								? { providerId: value, modelId: model.id }
								: undefined
						}
						await this.persist()
						this.display()
					})
			})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.ai.defaultModel.name'))
			.setDesc(i18n.t('settings.ai.defaultModel.desc'))
			.addDropdown((dropdown) => {
				const provider = getProviderById(
					this.plugin.settings.ai.providers,
					this.plugin.settings.ai.defaultModel?.providerId,
				)
				dropdown.addOption('', i18n.t('settings.ai.none'))
				for (const model of listModels(provider)) {
					dropdown.addOption(
						model.id,
						model.name || i18n.t('settings.ai.unnamedModel'),
					)
				}
				dropdown
					.setValue(this.plugin.settings.ai.defaultModel?.modelId || '')
					.setDisabled(!provider)
					.onChange(async (value) => {
						const providerId = this.plugin.settings.ai.defaultModel?.providerId
						if (providerId && value) {
							this.plugin.settings.ai.defaultModel = {
								providerId,
								modelId: value,
							}
						} else {
							this.plugin.settings.ai.defaultModel = undefined
						}
						await this.persist()
					})
			})

		new Setting(this.containerEl)
			.setName(i18n.t('settings.ai.yolo.name'))
			.setDesc(i18n.t('settings.ai.yolo.desc'))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.ai.yolo ?? false)
					.onChange(async (value) => {
						this.plugin.settings.ai.yolo = value
						await this.persist(false)
					}),
			)
	}

	private listUserManagedProviders() {
		return listProviders(this.plugin.settings.ai.providers).filter(
			(provider) =>
				!this.plugin.nutstoreLlmGatewayService.isManagedProvider(provider),
		)
	}

	private async persist(showNotice: boolean = true) {
		try {
			this.plugin.settings.ai.providers = sanitizeProviders(
				this.plugin.settings.ai.providers,
			)
			this.plugin.settings.ai.defaultModel = sanitizeDefaultSelections(
				this.plugin.settings.ai.providers,
				this.plugin.settings.ai.defaultModel,
			)
			await this.plugin.settingsService.saveSettings()
			if (showNotice) {
				new Notice(i18n.t('settings.ai.saved'))
			}
		} catch (error) {
			logger.error(error)
			new Notice(
				error instanceof Error
					? i18n.t('settings.ai.errors.saveFailedWithReason', {
							reason: error.message,
						})
					: i18n.t('settings.ai.errors.saveFailed'),
				10000,
			)
		}
	}
}
