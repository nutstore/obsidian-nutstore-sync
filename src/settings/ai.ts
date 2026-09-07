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
	private subagentsContainerEl?: HTMLElement

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
							void this.display()
						}).open()
					}),
			)

		if (this.listUserManagedProviders().length === 0) {
			this.containerEl.createEl('p', {
				cls: ':uno: -mt-1 mb-5 opacity-75',
				text: i18n.t('settings.ai.providers.emptyHint'),
			})
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
						void this.display()
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
						void this.display()
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
		this.containerEl.createEl('h3', {
			text: i18n.t('settings.ai.subagents.heading'),
		})
		this.subagentsContainerEl = this.containerEl.createDiv()
		this.renderSubagentSettings()
	}

	private renderSubagentSettings() {
		const containerEl = this.subagentsContainerEl
		if (!containerEl) return
		containerEl.empty()
		this.addSubagentSettings(containerEl, 'explorer')
		this.addSubagentSettings(containerEl, 'memory')
	}

	private addSubagentSettings(
		containerEl: HTMLElement,
		type: 'explorer' | 'memory',
	) {
		const config = this.plugin.settings.ai.subagents[type]
		const keys = `settings.ai.subagents.${type}` as const
		new Setting(containerEl)
			.setName(i18n.t(`${keys}.name`))
			.setDesc(i18n.t(`${keys}.desc`))
			.addToggle((toggle) =>
				toggle.setValue(config.enabled).onChange(async (enabled) => {
					config.enabled = enabled
					await this.persist(false)
					this.renderSubagentSettings()
				}),
			)
		if (!config.enabled) return

		new Setting(containerEl)
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
						await this.persist()
						this.renderSubagentSettings()
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
						await this.persist()
					})
			})
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
