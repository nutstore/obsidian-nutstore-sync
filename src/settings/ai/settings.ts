import { Notice, Setting } from 'obsidian'
import {
	getFirstModel,
	getModelById,
	getProviderById,
	listModels,
	sanitizeDefaultSelections,
	sanitizeProviders,
} from '~/ai/catalog/config'
import type { AIProviderConfig } from '~/ai/core/types'
import ProvidersManagerModal from '~/components/ProvidersManagerModal'
import McpServersManagerModal from '~/components/McpServersManagerModal'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import BaseSettings from '../settings.base'

export default class AISettings extends BaseSettings {
	readonly name = () => i18n.t('settings.sections.ai')
	readonly showGroupHeading = true

	getSearchTerms(): string[] {
		return [
			i18n.t('settings.ai.providers.name'),
			i18n.t('settings.ai.defaultProvider.name'),
			i18n.t('settings.ai.defaultProvider.desc'),
			i18n.t('settings.ai.defaultModel.name'),
			i18n.t('settings.ai.defaultModel.desc'),
			i18n.t('settings.ai.mcp.name'),
			i18n.t('settings.ai.yolo.name'),
			i18n.t('settings.ai.yolo.desc'),
		]
	}

	async display() {
		this.containerEl.empty()

		const providers = this.plugin.ai.gateway.listConfiguredProviders()
		this.renderProviders(providers)
		this.renderDefaultProvider(providers)
		if (providers.length > 0) this.renderDefaultModel(providers)
		this.renderMcpServers()
		this.renderAccessControl()
	}

	private renderProviders(providers: AIProviderConfig[]) {
		new Setting(this.containerEl)
			.setName(i18n.t('settings.ai.providers.name'))
			.setDesc(
				providers.length === 0
					? i18n.t('settings.ai.providers.emptyHint')
					: i18n.t('settings.ai.providers.summary', {
							count: providers.length,
						}),
			)
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.ai.providers.manage'))
					.onClick(() => {
						new ProvidersManagerModal(this.plugin, async () => {
							await this.persist(false)
							void this.display()
						}).open()
					})
			})
	}

	private renderDefaultProvider(providers: AIProviderConfig[]) {
		if (providers.length === 0) return

		new Setting(this.containerEl)
			.setName(i18n.t('settings.ai.defaultProvider.name'))
			.setDesc(i18n.t('settings.ai.defaultProvider.desc'))
			.addDropdown((dropdown) => {
				dropdown.addOption('', i18n.t('settings.ai.none'))
				for (const provider of providers) {
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
	}

	private renderDefaultModel(providers: AIProviderConfig[]) {
		const provider = providers.find(
			(item) => item.id === this.plugin.settings.ai.defaultModel?.providerId,
		)
		new Setting(this.containerEl)
			.setName(i18n.t('settings.ai.defaultModel.name'))
			.setDesc(i18n.t('settings.ai.defaultModel.desc'))
			.addDropdown((dropdown) => {
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
						void this.display()
					})
			})
	}

	private renderMcpServers() {
		const count = Object.keys(this.plugin.ai.mcp.getServers()).length
		new Setting(this.containerEl)
			.setName(i18n.t('settings.ai.mcp.name'))
			.setDesc(i18n.t('settings.ai.mcp.summary', { count }))
			.addButton((button) =>
				button.setButtonText(i18n.t('settings.ai.mcp.manage')).onClick(() => {
					new McpServersManagerModal(this.plugin, async () => {
						void this.display()
					}).open()
				}),
			)
	}

	private renderAccessControl() {
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
