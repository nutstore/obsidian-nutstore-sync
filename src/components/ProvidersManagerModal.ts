import { cloneDeep } from 'es-toolkit/compat'
import { Modal, Notice, setIcon } from 'obsidian'
import type { Subscription } from 'rxjs'
import {
	createModelConfig,
	createProviderConfig,
	listMissingPresetModelsForProvider,
	listModels,
	listProviders,
} from '~/ai/catalog/config'
import type { AIProviderConfig } from '~/ai/core/types'
import { getProviderDefaultBaseURL } from '~/ai/providers/defaults'
import { CHATBOX_AI_ICON_ID } from '~/assets/icons/obsidian-nutstore-ai-icon'
import { NUTSTORE_LLM_GATEWAY_PROVIDER_ID } from '~/consts'
import { onNutstoreLlmGatewayAuth } from '~/events/nutstore-llm-gateway-auth'
import i18n from '~/i18n'
import createId from '~/utils/create-id'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'
import NutstoreLlmGatewayModal from './NutstoreLlmGatewayModal'
import ProviderEditorModal from './ProviderEditorModal'
import ProviderModelsUpdateConfirmModal from './ProviderModelsUpdateConfirmModal'

type PresetModelsRefreshState = 'idle' | 'loading' | 'success' | 'error'
type ProviderButtonVariant =
	'primary' | 'secondary' | 'accent' | 'ghost' | 'danger'

interface PresetModelsRefreshSummary {
	providersDelta: number
	modelsDelta: number
}

interface ProviderButtonOptions {
	label: string
	icon?: string
	variant?: ProviderButtonVariant
	disabled?: boolean
	onClick?: () => Promise<void> | void
}

interface ProviderCardOptions {
	title: string
	description: string
	hint?: string
	badge?: string
	icon?: string
	initial?: string
}

interface ProviderCardElements {
	cardEl: HTMLElement
	actionsEl: HTMLElement
}

const MODAL_CLASS = 'providers-manager-modal'
const CONTENT_CLASS = `${MODAL_CLASS}__content`

function providerInitial(name: string) {
	return Array.from(name.trim())[0]?.toLocaleUpperCase() || '?'
}

export default class ProvidersManagerModal extends Modal {
	private readonly moduleScope
	private readonly gateway
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
		this.moduleScope = plugin.ai.lifecycle.scope
		this.gateway = plugin.ai.gateway
		this.moduleScope.ownModal(this)
	}

	onOpen() {
		this.modalEl.addClass(MODAL_CLASS)
		this.contentEl.addClass(CONTENT_CLASS)
		this.renderNativeTitle(i18n.t('settings.ai.providers.name'))
		this.authSubscription = onNutstoreLlmGatewayAuth().subscribe(() => {
			this.render()
		})
		this.render()
	}

	onClose() {
		this.authSubscription?.unsubscribe()
		this.authSubscription = null
		this.contentEl.empty()
		this.contentEl.removeClass(CONTENT_CLASS)
		this.titleEl.empty()
		this.modalEl.removeClass(MODAL_CLASS)
		this.modalEl.removeAttribute('aria-labelledby')
	}

	private render() {
		if (this.moduleScope.signal.aborted) return

		this.contentEl.empty()

		const body = this.contentEl.createEl('main', {
			cls: `${MODAL_CLASS}__body`,
		})
		this.renderToolbar(body)

		const list = body.createDiv({
			cls: `${MODAL_CLASS}__provider-list`,
		})

		this.renderNutstoreGatewayCard(list)
		const providers = listProviders(this.plugin.settings.ai.providers).filter(
			(provider) => !this.gateway.isManagedProvider(provider),
		)
		for (const provider of providers) {
			this.renderProviderCard(list, provider)
		}
	}

	private renderNativeTitle(title: string) {
		this.setTitle(title)
		this.titleEl.id ||= createId('accessible-label')
		this.modalEl.setAttribute('aria-labelledby', this.titleEl.id)
	}

	private renderToolbar(body: HTMLElement) {
		const toolbar = body.createDiv({
			cls: `${MODAL_CLASS}__toolbar`,
		})
		const heading = toolbar.createDiv({
			cls: `${MODAL_CLASS}__toolbar-heading`,
		})
		heading.createEl('h3', {
			cls: `${MODAL_CLASS}__section-title`,
			text: i18n.t('settings.ai.providers.services'),
		})
		heading.createSpan({
			cls: `${MODAL_CLASS}__section-hint`,
			text: i18n.t('settings.ai.providers.servicesHint'),
		})

		const actions = toolbar.createDiv({
			cls: `${MODAL_CLASS}__toolbar-actions`,
		})
		this.renderPresetModelsRefreshButton(actions)
		this.createActionButton(actions, {
			label: i18n.t('settings.ai.providers.add'),
			icon: 'plus',
			variant: 'primary',
			onClick: () => this.openCreateProvider(),
		})
	}

	private renderPresetModelsRefreshButton(parent: HTMLElement) {
		const state = this.presetModelsRefreshState
		const button = this.createActionButton(parent, {
			label: this.getPresetRefreshButtonText(),
			icon: this.getPresetRefreshIcon(),
			variant: 'ghost',
			disabled: state === 'loading',
			onClick: () => this.refreshPresetModels(),
		})
		button.addClass(`${MODAL_CLASS}__refresh`)
		button.setAttribute('aria-busy', String(state === 'loading'))
		button.classList.toggle('is-loading', state === 'loading')
		button.classList.toggle('is-success', state === 'success')
		button.classList.toggle('is-error', state === 'error')
	}

	private renderNutstoreGatewayCard(parent: HTMLElement) {
		const isAuthorized = this.gateway.isAuthorized()
		const isAuthorizing = this.gateway.isAuthorizing()
		const pendingAuthorization = this.gateway.getPendingAuthorization()
		const provider =
			this.plugin.settings.ai.providers[NUTSTORE_LLM_GATEWAY_PROVIDER_ID]
		const modelsCount = listModels(provider).length
		const providerName = i18n.t('settings.ai.nutstoreLlmGateway.name')
		const description = isAuthorized
			? i18n.t('settings.ai.nutstoreLlmGateway.connectedDesc', {
					count: modelsCount,
				})
			: pendingAuthorization
				? i18n.t('settings.ai.nutstoreLlmGateway.pendingDesc', {
						code: pendingAuthorization.userCode,
					})
				: i18n.t('settings.ai.nutstoreLlmGateway.desc')

		const { cardEl, actionsEl } = this.createProviderCard(parent, {
			title: providerName,
			description,
			badge: i18n.t('settings.ai.providers.builtIn'),
			icon: CHATBOX_AI_ICON_ID,
		})
		cardEl.addClass(`${MODAL_CLASS}__provider-card--nutstore`)

		if (pendingAuthorization) {
			this.createActionButton(actionsEl, {
				label: i18n.t('settings.ai.nutstoreLlmGateway.openAuthorizationPage'),
				icon: 'external-link',
				variant: 'accent',
				onClick: () => this.openPendingAuthorizationPage(),
			})
			this.createActionButton(actionsEl, {
				label: i18n.t('settings.ai.nutstoreLlmGateway.cancelAuthorization'),
				variant: 'danger',
				onClick: async () => {
					await this.gateway.disconnect()
					this.render()
				},
			})
		} else if (!isAuthorized) {
			this.createActionButton(actionsEl, {
				label: isAuthorizing
					? i18n.t('settings.ai.nutstoreLlmGateway.authorizing')
					: i18n.t('settings.ai.nutstoreLlmGateway.authorize'),
				icon: isAuthorizing ? 'loader-circle' : 'key-round',
				variant: 'accent',
				disabled: isAuthorizing,
				onClick: () => this.openNutstoreAuthorization(),
			}).classList.toggle('is-loading', isAuthorizing)
		} else {
			this.createActionButton(actionsEl, {
				label: i18n.t('settings.ai.nutstoreLlmGateway.usage.button'),
				icon: 'chart-spline',
				variant: 'secondary',
				onClick: () =>
					new NutstoreLlmGatewayModal(this.plugin, async () => {
						await this.onChanged()
						this.render()
					}).open(),
			})
			this.createDestructiveActionButton(
				actionsEl,
				i18n.t('settings.ai.modals.confirmDeleteLabel'),
				{
					label: i18n.t('settings.ai.nutstoreLlmGateway.disconnect'),
					onConfirm: async () => {
						await this.gateway.disconnect()
						await this.onChanged()
						this.render()
					},
				},
			)
		}

		this.markMultiActionCard(cardEl, actionsEl)
	}

	private renderProviderCard(parent: HTMLElement, provider: AIProviderConfig) {
		const providerName = provider.name || i18n.t('settings.ai.unnamedProvider')
		const missingPresetModels = listMissingPresetModelsForProvider(provider)
		const { cardEl, actionsEl } = this.createProviderCard(parent, {
			title: providerName,
			description:
				provider.api ||
				getProviderDefaultBaseURL(provider.npm) ||
				i18n.t('settings.ai.providers.defaultEndpoint'),
			hint:
				missingPresetModels.length > 0
					? i18n.t('settings.ai.providers.updateModelsHint', {
							count: missingPresetModels.length,
						})
					: undefined,
			initial: providerInitial(providerName),
		})

		if (missingPresetModels.length > 0) {
			this.createActionButton(actionsEl, {
				label: i18n.t('settings.ai.providers.updateModels'),
				icon: 'plus',
				variant: 'accent',
				onClick: () =>
					this.openProviderModelsUpdate(provider, missingPresetModels),
			})
		}
		this.createActionButton(actionsEl, {
			label: i18n.t('settings.ai.modals.provider.edit'),
			icon: 'pencil',
			variant: 'secondary',
			onClick: () => this.openEditProvider(provider),
		})
		this.createDestructiveActionButton(
			actionsEl,
			i18n.t('settings.ai.modals.confirmDeleteLabel'),
			{
				label: i18n.t('settings.ai.providers.delete'),
				onConfirm: () => this.deleteProvider(provider),
			},
		)

		this.markMultiActionCard(cardEl, actionsEl)
	}

	private createProviderCard(
		parent: HTMLElement,
		options: ProviderCardOptions,
	): ProviderCardElements {
		const cardEl = parent.createEl('article', {
			cls: `${MODAL_CLASS}__provider-card`,
		})
		const icon = cardEl.createSpan({
			cls: `${MODAL_CLASS}__provider-icon`,
			attr: { 'aria-hidden': 'true' },
			text: options.icon ? undefined : (options.initial ?? '?'),
		})
		if (options.icon) setIcon(icon, options.icon)

		const copy = cardEl.createDiv({
			cls: `${MODAL_CLASS}__provider-copy`,
		})
		const titleRow = copy.createDiv({
			cls: `${MODAL_CLASS}__provider-title-row`,
		})
		titleRow.createEl('h4', {
			cls: `${MODAL_CLASS}__provider-title`,
			text: options.title,
		})
		if (options.badge) {
			titleRow.createSpan({
				cls: `${MODAL_CLASS}__provider-badge`,
				text: options.badge,
			})
		}
		copy.createEl('p', {
			cls: `${MODAL_CLASS}__provider-description`,
			text: options.description,
		})
		if (options.hint) {
			copy.createEl('p', {
				cls: `${MODAL_CLASS}__provider-hint`,
				text: options.hint,
			})
		}

		const actionsEl = cardEl.createDiv({
			cls: `${MODAL_CLASS}__provider-actions`,
		})
		return { cardEl, actionsEl }
	}

	private createActionButton(
		parent: HTMLElement,
		options: ProviderButtonOptions,
	) {
		const variant = options.variant ?? 'secondary'
		const button = parent.createEl('button', {
			cls: `${MODAL_CLASS}__button ${MODAL_CLASS}__button--${variant}`,
		})
		button.type = 'button'
		button.disabled = options.disabled ?? false

		if (options.icon) {
			const icon = button.createSpan({
				cls: `${MODAL_CLASS}__button-icon`,
				attr: { 'aria-hidden': 'true' },
			})
			setIcon(icon, options.icon)
		}
		if (options.label) {
			button.createSpan({
				cls: `${MODAL_CLASS}__button-label`,
				text: options.label,
			})
		}
		if (options.onClick) {
			button.addEventListener('click', () => {
				void Promise.resolve(options.onClick?.()).catch((error) =>
					logger.error(error),
				)
			})
		}
		return button
	}

	private createDestructiveActionButton(
		parent: HTMLElement,
		confirmLabel: string,
		options: {
			label: string
			onConfirm: () => Promise<void> | void
		},
	) {
		let confirming = false
		const button = this.createActionButton(parent, {
			label: '',
			icon: 'trash',
			variant: 'danger',
		})
		button.addClass('is-icon-only')
		const setIdleContent = () => {
			button.empty()
			setIcon(button, 'trash')
			const label = button.createSpan({
				cls: `${MODAL_CLASS}__sr-only`,
				text: options.label,
			})
			label.id = createId('accessible-label')
			button.setAttribute('aria-labelledby', label.id)
		}
		setIdleContent()
		const reset = () => {
			if (!confirming) return
			confirming = false
			setIdleContent()
			button.addClass('is-icon-only')
			button.removeClass('is-confirming')
		}
		button.addEventListener('blur', reset)
		button.addEventListener('click', () => {
			if (!confirming) {
				confirming = true
				button.empty()
				const label = button.createSpan({
					cls: `${MODAL_CLASS}__button-label`,
					text: confirmLabel,
				})
				label.id = createId('accessible-label')
				button.removeClass('is-icon-only')
				button.addClass('is-confirming')
				button.setAttribute('aria-labelledby', label.id)
				return
			}
			void Promise.resolve(options.onConfirm()).catch((error) =>
				logger.error(error),
			)
		})
		return button
	}

	private markMultiActionCard(cardEl: HTMLElement, actionsEl: HTMLElement) {
		if (actionsEl.childElementCount > 1) {
			cardEl.addClass(`${MODAL_CLASS}__provider-card--multi-action`)
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
				return i18n.t('settings.ai.providers.refreshShort')
		}
	}

	private getPresetRefreshIcon() {
		switch (this.presetModelsRefreshState) {
			case 'loading':
				return 'loader-circle'
			case 'success':
				return 'check'
			case 'error':
				return 'triangle-alert'
			default:
				return 'refresh-cw'
		}
	}

	private formatSignedDelta(value: number) {
		return value >= 0 ? `+${value}` : `${value}`
	}

	private async refreshPresetModels() {
		if (this.presetModelsRefreshState === 'loading') return
		this.presetModelsRefreshState = 'loading'
		this.presetModelsRefreshSummary = {
			providersDelta: 0,
			modelsDelta: 0,
		}
		this.render()
		try {
			const result = await this.plugin.ai.models.refreshFromRemote()
			if (this.moduleScope.signal.aborted) return
			this.presetModelsRefreshState = result.success ? 'success' : 'error'
			this.presetModelsRefreshSummary = {
				providersDelta: result.providersDelta,
				modelsDelta: result.modelsDelta,
			}
			if (!result.success) {
				new Notice(
					result.errorMessage
						? i18n.t(
								'settings.ai.providers.presetModelsRefreshFailedWithReason',
								{ reason: result.errorMessage },
							)
						: i18n.t('settings.ai.providers.presetModelsRefreshFailed'),
					10000,
				)
			}
		} catch (error) {
			if (this.moduleScope.signal.aborted) return
			logger.error(error)
			this.presetModelsRefreshState = 'error'
			new Notice(
				error instanceof Error
					? i18n.t(
							'settings.ai.providers.presetModelsRefreshFailedWithReason',
							{ reason: error.message },
						)
					: i18n.t('settings.ai.providers.presetModelsRefreshFailed'),
				10000,
			)
		} finally {
			this.render()
		}
	}

	private openCreateProvider() {
		this.openProviderEditor(createProviderConfig(), true)
	}

	private openEditProvider(provider: AIProviderConfig) {
		this.openProviderEditor(provider, false)
	}

	private openProviderEditor(provider: AIProviderConfig, isNew: boolean) {
		new ProviderEditorModal(
			this.plugin,
			provider,
			async (savedProvider) => {
				if (
					!this.validateProviderKey(
						savedProvider,
						isNew ? undefined : provider.id,
					)
				) {
					return false
				}

				if (isNew) {
					this.plugin.settings.ai.providers = {
						...this.plugin.settings.ai.providers,
						[savedProvider.id]: savedProvider,
					}
				} else {
					const nextProviders: Record<string, AIProviderConfig> = {}
					for (const [key, value] of Object.entries(
						this.plugin.settings.ai.providers,
					)) {
						if (key === provider.id) {
							nextProviders[savedProvider.id] = savedProvider
						} else {
							nextProviders[key] = value
						}
					}
					this.plugin.settings.ai.providers = nextProviders
				}
				await this.onChanged()
				this.render()
				return true
			},
			isNew,
		).open()
	}

	private async openProviderModelsUpdate(
		provider: AIProviderConfig,
		models: AIProviderConfig['models'][string][],
	) {
		const confirmed = await this.moduleScope
			.ownModal(
				new ProviderModelsUpdateConfirmModal(this.plugin.app, provider, models),
			)
			.openAndWait()
		if (!confirmed || this.moduleScope.signal.aborted) return
		await this.addMissingPresetModels(provider, models)
	}

	private async openNutstoreAuthorization() {
		try {
			await this.gateway.startAuthorization()
			await this.gateway.openPendingAuthorizationPage()
			this.render()
		} catch (error) {
			this.reportAuthorizationError(error)
		}
	}

	private async openPendingAuthorizationPage() {
		try {
			await this.gateway.openPendingAuthorizationPage()
		} catch (error) {
			this.reportAuthorizationError(error)
		}
	}

	private reportAuthorizationError(error: unknown) {
		if (this.moduleScope.signal.aborted) return
		logger.error(error)
		new Notice(
			error instanceof Error ? error.message : i18n.t('settings.login.failure'),
			10000,
		)
	}

	private validateProviderKey(provider: AIProviderConfig, currentId?: string) {
		if (!provider.id) {
			new Notice(i18n.t('settings.ai.errors.emptyProviderId'))
			return false
		}
		if (this.gateway.isProviderId(provider.id)) {
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
			if (this.moduleScope.signal.aborted) return
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
			if (this.moduleScope.signal.aborted) return
			logger.error(error)
			new Notice(
				error instanceof Error
					? error.message
					: i18n.t('settings.ai.errors.saveFailed'),
			)
		}
	}
}
