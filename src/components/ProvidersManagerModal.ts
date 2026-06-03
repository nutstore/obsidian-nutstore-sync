import { cloneDeep } from 'lodash-es'
import { Modal, Notice, Setting, setIcon } from 'obsidian'
import { Subscription } from 'rxjs'
import {
	createModelConfig,
	createProviderConfig,
	createProviderFromPreset,
	listMissingPresetModelsForProvider,
	listModels,
	listPresetProviders,
	listProviders,
} from '~/ai/config'
import { AIProviderConfig } from '~/ai/types'
import { NUTSTORE_LLM_GATEWAY_PROVIDER_ID } from '~/consts'
import { onNutstoreLlmGatewayAuth } from '~/events/nutstore-llm-gateway-auth'
import i18n from '~/i18n'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'
import NutstoreLlmGatewayBetaConfirmModal from './NutstoreLlmGatewayBetaConfirmModal'
import ProviderEditorModal from './ProviderEditorModal'
import ProviderModelsUpdateConfirmModal from './ProviderModelsUpdateConfirmModal'

const CUSTOM_OPTION = '__custom__'
type PresetModelsRefreshState = 'idle' | 'loading' | 'success' | 'error'
interface PresetModelsRefreshSummary {
	providersDelta: number
	modelsDelta: number
}

export default class ProvidersManagerModal extends Modal {
	private selectedPresetId = CUSTOM_OPTION
	private authSubscription: Subscription | null = null
	private presetModelsRefreshState: PresetModelsRefreshState = 'idle'
	private presetModelsRefreshSummary: PresetModelsRefreshSummary = {
		providersDelta: 0,
		modelsDelta: 0,
	}

	constructor(
		private plugin: NutstorePlugin,
		private onChanged: () => Promise<void> | void,
	) {
		super(plugin.app)
	}

	onOpen() {
		this.authSubscription = onNutstoreLlmGatewayAuth().subscribe(() => {
			this.render()
		})
		this.render()
	}

	private render() {
		const { contentEl } = this
		contentEl.empty()
		contentEl.createEl('h2', {
			text: i18n.t('settings.ai.modals.providers.title'),
		})

		const presets = listPresetProviders()

		new Setting(contentEl)
			.setName(i18n.t('settings.ai.providers.refreshPresetName'))
			.setDesc(i18n.t('settings.ai.providers.refreshPresetDesc'))
			.addButton((button) => {
				button
					.setButtonText(this.getPresetRefreshButtonText())
					.setDisabled(this.presetModelsRefreshState === 'loading')

				const buttonEl = button.buttonEl
				buttonEl.classList.toggle(
					'connection-button',
					this.presetModelsRefreshState !== 'idle',
				)
				buttonEl.classList.toggle(
					'loading',
					this.presetModelsRefreshState === 'loading',
				)
				buttonEl.classList.toggle(
					'success',
					this.presetModelsRefreshState === 'success',
				)
				buttonEl.classList.toggle(
					'mod-warning',
					this.presetModelsRefreshState === 'error',
				)

				button.onClick(async () => {
					if (this.presetModelsRefreshState === 'loading') {
						return
					}
					this.presetModelsRefreshState = 'loading'
					this.presetModelsRefreshSummary = {
						providersDelta: 0,
						modelsDelta: 0,
					}
					this.render()
					try {
						const result =
							await this.plugin.modelsPresetService.refreshFromRemote()
						this.presetModelsRefreshState = result.success ? 'success' : 'error'
						this.presetModelsRefreshSummary = {
							providersDelta: result.providersDelta,
							modelsDelta: result.modelsDelta,
						}
					} catch (error) {
						logger.error(error)
						this.presetModelsRefreshState = 'error'
					} finally {
						this.render()
					}
				})
			})

		new Setting(contentEl)
			.setName(i18n.t('settings.ai.providers.name'))
			.setDesc(i18n.t('settings.ai.providers.desc'))
			.addDropdown((dropdown) => {
				dropdown.selectEl.classList.add('max-w-32!')
				dropdown.addOption(
					CUSTOM_OPTION,
					i18n.t('settings.ai.providers.presetCustom'),
				)
				for (const preset of presets) {
					dropdown.addOption(preset.id, preset.name)
				}
				dropdown.setValue(this.selectedPresetId)
				dropdown.onChange((value) => {
					this.selectedPresetId = value
				})
			})
			.addButton((button) =>
				button
					.setButtonText(i18n.t('settings.ai.providers.add'))
					.setCta()
					.onClick(() => {
						const preset =
							this.selectedPresetId !== CUSTOM_OPTION
								? presets.find((p) => p.id === this.selectedPresetId)
								: undefined
						const draft = preset
							? createProviderFromPreset(preset, '')
							: createProviderConfig()
						new ProviderEditorModal(
							this.plugin,
							draft,
							async (provider) => {
								if (!this.validateProviderKey(provider)) {
									return false
								}
								this.plugin.settings.ai.providers = {
									...this.plugin.settings.ai.providers,
									[provider.id]: provider,
								}
								await this.onChanged()
								this.render()
								return true
							},
							true,
						).open()
					}),
			)

		this.renderNutstoreGatewaySection()

		const providers = listProviders(this.plugin.settings.ai.providers).filter(
			(provider) =>
				!this.plugin.nutstoreLlmGatewayService.isManagedProvider(provider),
		)
		if (providers.length === 0) {
			contentEl.createDiv({
				cls: 'setting-item-description',
				text: i18n.t('settings.ai.providers.empty'),
			})
			return
		}

		for (const provider of providers) {
			const missingPresetModels = listMissingPresetModelsForProvider(provider)
			new Setting(contentEl)
				.setName(provider.name || i18n.t('settings.ai.unnamedProvider'))
				.setDesc(provider.api || i18n.t('settings.ai.providers.openaiDefault'))
				.then((setting) => {
					if (missingPresetModels.length > 0) {
						setting.descEl.createDiv({
							cls: 'setting-item-description',
							text: i18n.t('settings.ai.providers.updateModelsHint', {
								count: missingPresetModels.length,
							}),
						})
					}
				})
				.addButton((button) => {
					if (missingPresetModels.length === 0) {
						button.buttonEl.style.display = 'none'
						return
					}
					button
						.setButtonText(i18n.t('settings.ai.providers.updateModels'))
						.setCta()
						.onClick(async () => {
							const confirmed = await new ProviderModelsUpdateConfirmModal(
								this.plugin.app,
								provider,
								missingPresetModels,
							).open()
							if (!confirmed) return
							await this.addMissingPresetModels(provider, missingPresetModels)
						})
				})
				.addButton((button) =>
					button
						.setButtonText(i18n.t('settings.ai.modals.provider.edit'))
						.onClick(() => {
							new ProviderEditorModal(
								this.plugin,
								provider,
								async (savedProvider) => {
									if (!this.validateProviderKey(savedProvider, provider.id)) {
										return false
									}
									const { [provider.id]: _old, ...rest } =
										this.plugin.settings.ai.providers
									this.plugin.settings.ai.providers = {
										...rest,
										[savedProvider.id]: savedProvider,
									}
									await this.onChanged()
									this.render()
									return true
								},
								false,
							).open()
						}),
				)
				.addButton((button) => {
					let confirmDelete = false

					const resetButton = () => {
						confirmDelete = false
						button.buttonEl.empty()
						setIcon(button.buttonEl, 'trash')
						button.buttonEl.removeClass('mod-warning')
					}

					button.setIcon('trash').onClick(async () => {
						if (!confirmDelete) {
							confirmDelete = true
							button.buttonEl.empty()
							button.buttonEl.createSpan({
								text: i18n.t('settings.ai.modals.confirmDeleteLabel'),
							})
							button.buttonEl.addClass('mod-warning')
							return
						}
						await this.deleteProvider(provider)
					})
					button.buttonEl.addEventListener('blur', resetButton)
				})
		}
	}

	private getPresetRefreshButtonText() {
		switch (this.presetModelsRefreshState) {
			case 'loading':
				return i18n.t('settings.ai.providers.refreshPresetModelsLoading')
			case 'success':
				return i18n.t('settings.ai.providers.refreshPresetModelsSuccess', {
					providers: this.formatSignedDelta(
						this.presetModelsRefreshSummary.providersDelta,
					),
					models: this.formatSignedDelta(
						this.presetModelsRefreshSummary.modelsDelta,
					),
				})
			case 'error':
				return i18n.t('settings.ai.providers.refreshPresetModelsFailure')
			default:
				return i18n.t('settings.ai.providers.refreshPresetModels')
		}
	}

	private formatSignedDelta(value: number) {
		if (value >= 0) {
			return `+${value}`
		}
		return `${value}`
	}

	private renderNutstoreGatewaySection() {
		const { contentEl } = this
		const isAuthorized = this.plugin.nutstoreLlmGatewayService.isAuthorized()
		const isAuthorizing = this.plugin.nutstoreLlmGatewayService.isAuthorizing()
		const pendingAuthorization =
			this.plugin.nutstoreLlmGatewayService.getPendingAuthorization()
		const provider =
			this.plugin.settings.ai.providers[NUTSTORE_LLM_GATEWAY_PROVIDER_ID]
		const modelsCount = listModels(provider).length

		const setting = new Setting(contentEl)
			.setName(i18n.t('settings.ai.nutstoreLlmGateway.name'))
			.setDesc(
				isAuthorized
					? i18n.t('settings.ai.nutstoreLlmGateway.connectedDesc', {
							count: modelsCount,
						})
					: pendingAuthorization
						? i18n.t('settings.ai.nutstoreLlmGateway.pendingDesc', {
								code: pendingAuthorization.userCode,
							})
						: i18n.t('settings.ai.nutstoreLlmGateway.desc'),
			)

		if (!isAuthorized) {
			setting.addButton((button) => {
				button
					.setButtonText(
						isAuthorizing
							? i18n.t('settings.ai.nutstoreLlmGateway.authorizing')
							: i18n.t('settings.ai.nutstoreLlmGateway.authorize'),
					)
					.setDisabled(isAuthorizing)
				if (isAuthorizing) {
					button.buttonEl.classList.add('connection-button', 'loading')
					return
				}
				button.onClick(() => {
					new NutstoreLlmGatewayBetaConfirmModal(this.plugin.app, async () => {
						try {
							await this.plugin.nutstoreLlmGatewayService.startAuthorization()
							await this.plugin.nutstoreLlmGatewayService.openPendingAuthorizationPage()
							this.render()
						} catch (error) {
							logger.error(error)
							new Notice(
								error instanceof Error
									? error.message
									: i18n.t('settings.login.failure'),
								10000,
							)
						}
					}).open()
				})
			})
			if (pendingAuthorization) {
				setting.addButton((button) =>
					button
						.setButtonText(
							i18n.t('settings.ai.nutstoreLlmGateway.openAuthorizationPage'),
						)
						.onClick(async () => {
							try {
								await this.plugin.nutstoreLlmGatewayService.openPendingAuthorizationPage()
							} catch (error) {
								logger.error(error)
								new Notice(
									error instanceof Error
										? error.message
										: i18n.t('settings.login.failure'),
									10000,
								)
							}
						}),
				)
				setting.addButton((button) =>
					button
						.setWarning()
						.setButtonText(
							i18n.t('settings.ai.nutstoreLlmGateway.cancelAuthorization'),
						)
						.onClick(async () => {
							await this.plugin.nutstoreLlmGatewayService.disconnect()
							this.render()
						}),
				)
			}
			return
		}

		setting
			.addButton((button) =>
				button
					.setButtonText(i18n.t('settings.ai.nutstoreLlmGateway.refreshModels'))
					.onClick(async () => {
						try {
							await this.plugin.nutstoreLlmGatewayService.refreshModels({
								removeOnAuthError: true,
							})
							await this.plugin.saveSettings()
							new Notice(
								i18n.t('settings.ai.nutstoreLlmGateway.modelsRefreshed'),
							)
							this.render()
						} catch (error) {
							logger.error(error)
							new Notice(
								error instanceof Error
									? error.message
									: i18n.t(
											'settings.ai.nutstoreLlmGateway.errors.refreshFailed',
										),
								10000,
							)
						}
					}),
			)
			.addButton((button) => {
				let confirmDisconnect = false

				const resetButton = () => {
					confirmDisconnect = false
					button.buttonEl.empty()
					setIcon(button.buttonEl, 'trash')
					button.buttonEl.removeClass('mod-warning')
				}

				button.setIcon('trash').onClick(async () => {
					if (!confirmDisconnect) {
						confirmDisconnect = true
						button.buttonEl.empty()
						button.buttonEl.createSpan({
							text: i18n.t('settings.ai.modals.confirmDeleteLabel'),
						})
						button.buttonEl.addClass('mod-warning')
						return
					}
					await this.plugin.nutstoreLlmGatewayService.disconnect()
					this.render()
				})

				button.buttonEl.addEventListener('blur', resetButton)
			})
	}

	private validateProviderKey(provider: AIProviderConfig, currentId?: string) {
		if (!provider.id) {
			new Notice(i18n.t('settings.ai.errors.emptyProviderId'))
			return false
		}
		if (this.plugin.nutstoreLlmGatewayService.isProviderId(provider.id)) {
			new Notice(i18n.t('settings.ai.errors.reservedProviderId'))
			return false
		}
		const existing = this.plugin.settings.ai.providers[provider.id]
		if (existing && existing.id !== currentId) {
			new Notice(i18n.t('settings.ai.errors.duplicateProviderId'))
			return false
		}
		return true
	}

	private async deleteProvider(provider: AIProviderConfig) {
		try {
			const { [provider.id]: _deleted, ...providers } =
				this.plugin.settings.ai.providers
			this.plugin.settings.ai.providers = providers
			await this.onChanged()
			new Notice(i18n.t('settings.ai.modals.provider.deleted'))
			this.render()
		} catch (error) {
			logger.error(error)
			new Notice(
				error instanceof Error
					? error.message
					: i18n.t('settings.ai.errors.saveFailed'),
			)
		}
	}

	private async addMissingPresetModels(
		provider: AIProviderConfig,
		models: AIProviderConfig['models'][string][],
	) {
		try {
			const existing = this.plugin.settings.ai.providers[provider.id]
			if (!existing) return
			const mergedModels = { ...existing.models }
			for (const model of models) {
				mergedModels[model.id] = createModelConfig(cloneDeep(model), model.id)
			}
			this.plugin.settings.ai.providers = {
				...this.plugin.settings.ai.providers,
				[provider.id]: {
					...existing,
					models: mergedModels,
				},
			}
			await this.onChanged()
			new Notice(
				i18n.t('settings.ai.providers.updateModelsSuccess', {
					count: models.length,
				}),
			)
			this.render()
		} catch (error) {
			logger.error(error)
			new Notice(
				error instanceof Error
					? error.message
					: i18n.t('settings.ai.errors.saveFailed'),
			)
		}
	}

	onClose() {
		this.authSubscription?.unsubscribe()
		this.authSubscription = null
		this.contentEl.empty()
	}
}
