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
import McpServersManagerModal from '~/components/McpServersManagerModal'
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

		if (this.listUserManagedProviders().length === 0) {
			const hintEl = this.containerEl.createEl('p', {
				text: i18n.t('settings.ai.providers.emptyHint'),
			})
			hintEl.style.margin = '-0.25rem 0 1.25rem'
			hintEl.style.opacity = '0.75'
		}

		new Setting(this.containerEl)
			.setName(i18n.t('settings.ai.defaultModel.name'))
			.setDesc(i18n.t('settings.ai.defaultModel.desc'))
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
			.setName(i18n.t('settings.ai.mcp.name'))
			.setDesc(
				i18n.t('settings.ai.mcp.summary', {
					count: Object.keys(this.plugin.mcpService.getServers()).length,
				}),
			)
			.addButton((button) =>
				button.setButtonText(i18n.t('settings.ai.mcp.manage')).onClick(() => {
					new McpServersManagerModal(this.plugin, async () => {
						this.display()
					}).open()
				}),
			)

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

		this.displayMemoTriggerSettings()
	}

	private displayMemoTriggerSettings() {
		const memoTrigger = this.plugin.settings.ai.memoTrigger ?? {
			enabled: false,
			threshold: 10,
			// Keep in sync with DEFAULT_SETTINGS.ai.memoTrigger.message
			message: '总结备忘录',
		}

		new Setting(this.containerEl)
			.setName(i18n.t('settings.ai.memoTrigger.section'))
			.setHeading()

		new Setting(this.containerEl)
			.setName(i18n.t('settings.ai.memoTrigger.enabled.name'))
			.setDesc(i18n.t('settings.ai.memoTrigger.enabled.desc'))
			.addToggle((toggle) =>
				toggle.setValue(memoTrigger.enabled).onChange(async (value) => {
					memoTrigger.enabled = value
					this.plugin.settings.ai.memoTrigger = memoTrigger
					await this.persist(false)
				}),
			)

		new Setting(this.containerEl)
			.setName(i18n.t('settings.ai.memoTrigger.threshold.name'))
			.setDesc(i18n.t('settings.ai.memoTrigger.threshold.desc'))
			.addText((text) =>
				text.setValue(String(memoTrigger.threshold)).onChange(async (value) => {
					const parsed = parseInt(value, 10)
					memoTrigger.threshold = Number.isNaN(parsed) ? 10 : parsed
					this.plugin.settings.ai.memoTrigger = memoTrigger
					await this.persist(false)
				}),
			)

		new Setting(this.containerEl)
			.setName(i18n.t('settings.ai.memoTrigger.message.name'))
			.setDesc(i18n.t('settings.ai.memoTrigger.message.desc'))
			.addText((text) =>
				text.setValue(memoTrigger.message).onChange(async (value) => {
					memoTrigger.message = value
					this.plugin.settings.ai.memoTrigger = memoTrigger
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
