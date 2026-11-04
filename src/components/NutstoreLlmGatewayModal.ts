import createId from '~/utils/create-id'
import { ButtonComponent, Modal } from 'obsidian'
import { listModels } from '~/ai/catalog/config'
import { NUTSTORE_LLM_GATEWAY_PROVIDER_ID } from '~/consts'
import i18n from '~/i18n'
import type {
	NutstoreLlmGatewayCreditPackage,
	NutstoreLlmGatewayUsage,
	NutstoreLlmGatewayUsageWindow,
} from '~/services/nutstore-llm-gateway.service'
import logger from '~/utils/logger'
import type NutstorePlugin from '..'

type NutstoreLlmGatewayTab = 'models' | 'usage'
type RefreshStatus = 'idle' | 'loading' | 'success' | 'error'

const GATEWAY_PANEL_ID = 'nutstore-llm-gateway-panel'

interface ModelSummary {
	id: string
	name: string
}
interface ModelListDiff {
	beforeCount: number
	afterCount: number
	added: ModelSummary[]
	removed: ModelSummary[]
}

function formatNumber(value: number) {
	return new Intl.NumberFormat().format(value)
}

function formatDate(value: string | null | undefined) {
	if (!value) {
		return ''
	}
	const date = new Date(value)
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function usedPercentage(remainingPercentage: number, total: number) {
	if (total <= 0) {
		return 0
	}
	if (!Number.isFinite(remainingPercentage)) {
		return 0
	}
	const remaining = Math.min(100, Math.max(0, remainingPercentage))
	return Math.round(100 - remaining)
}

function compareModels(
	before: ModelSummary[],
	after: ModelSummary[],
): ModelListDiff {
	const beforeById = new Map(before.map((model) => [model.id, model]))
	const afterById = new Map(after.map((model) => [model.id, model]))
	const added: ModelSummary[] = []
	const removed: ModelSummary[] = []

	for (const previous of before) {
		const current = afterById.get(previous.id)
		if (!current) {
			removed.push(previous)
		} else if (current.name !== previous.name) {
			removed.push(previous)
			added.push(current)
		}
	}
	for (const current of after) {
		if (!beforeById.has(current.id)) {
			added.push(current)
		}
	}

	return {
		beforeCount: before.length,
		afterCount: after.length,
		added,
		removed,
	}
}

function modelLabel(model: ModelSummary) {
	return model.name && model.name !== model.id
		? `${model.name} (${model.id})`
		: model.id
}

export default class NutstoreLlmGatewayModal extends Modal {
	private readonly moduleScope
	private readonly gateway
	private activeTab: NutstoreLlmGatewayTab = 'usage'
	private usage: NutstoreLlmGatewayUsage | null = null
	private usageError: string | null = null
	private usageLoading = false
	private usageLoaded = false
	private usageRefreshStatus: RefreshStatus = 'idle'
	private usageUpdatedAt: number | null = null
	private modelRefreshStatus: RefreshStatus = 'idle'
	private modelRefreshError: string | null = null
	private modelDiff: ModelListDiff | null = null
	private modelsUpdatedAt: number | null = null
	private active = false

	constructor(
		private plugin: NutstorePlugin,
		private onModelsUpdated: () => Promise<void> | void,
	) {
		super(plugin.app)
		this.moduleScope = plugin.ai.lifecycle.scope
		this.gateway = plugin.ai.gateway
		this.moduleScope.ownModal(this)
	}

	onOpen() {
		this.active = true
		this.titleEl.setText(i18n.t('settings.ai.nutstoreLlmGateway.usage.title'))
		this.modalEl.addClass('nutstore-llm-gateway-modal')
		this.contentEl.addClass('nutstore-llm-gateway-modal__content')
		void this.loadUsage()
	}

	private get isBusy() {
		return this.usageLoading || this.modelRefreshStatus === 'loading'
	}

	private getCurrentModels(): ModelSummary[] {
		const provider =
			this.plugin.settings.ai.providers[NUTSTORE_LLM_GATEWAY_PROVIDER_ID]
		return listModels(provider)
			.map((model) => ({
				id: model.id,
				name: model.name.trim() || model.id,
			}))
			.sort((left, right) => left.id.localeCompare(right.id))
	}

	private selectTab(tab: NutstoreLlmGatewayTab) {
		if (this.isBusy && tab !== this.activeTab) {
			return
		}
		this.activeTab = tab
		if (tab === 'usage' && !this.usageLoaded) {
			void this.loadUsage()
		} else {
			this.render()
		}
		this.focusTab(tab)
	}

	private focusTab(tab: NutstoreLlmGatewayTab) {
		this.contentEl
			.querySelector<HTMLButtonElement>(`[data-nutstore-tab="${tab}"]`)
			?.focus()
	}

	private handleTabKeydown(event: KeyboardEvent, tab: NutstoreLlmGatewayTab) {
		if (this.isBusy) {
			return
		}
		let nextTab: NutstoreLlmGatewayTab | undefined
		if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
			nextTab = tab === 'usage' ? 'models' : 'usage'
		} else if (event.key === 'Home') {
			nextTab = 'usage'
		} else if (event.key === 'End') {
			nextTab = 'models'
		}
		if (!nextTab) {
			return
		}
		event.preventDefault()
		this.selectTab(nextTab)
	}

	private async loadUsage() {
		if (this.isBusy) {
			return
		}
		this.usageLoading = true
		this.usageError = null
		this.usageRefreshStatus = 'loading'
		this.render()
		try {
			this.usage = await this.gateway.getUsage()
			this.usageLoaded = true
			this.usageUpdatedAt = Date.now()
			this.usageRefreshStatus = 'success'
		} catch (error) {
			if (this.moduleScope.signal.aborted) return
			this.usageLoaded = true
			this.usageError =
				error instanceof Error
					? error.message
					: i18n.t('settings.ai.nutstoreLlmGateway.usage.loadFailed')
			this.usageRefreshStatus = 'error'
		} finally {
			this.usageLoading = false
			if (this.active) {
				this.render()
			}
		}
	}

	private async updateModels() {
		if (this.isBusy) {
			return
		}
		const previousModels = this.getCurrentModels()
		this.modelRefreshStatus = 'loading'
		this.modelRefreshError = null
		this.modelDiff = null
		this.render()
		try {
			const refreshed = await this.gateway.refreshModels({
				removeOnAuthError: true,
			})
			if (refreshed) {
				const diff = compareModels(previousModels, this.getCurrentModels())
				this.modelDiff = diff.added.length || diff.removed.length ? diff : null
				this.modelsUpdatedAt = Date.now()
			}
			await this.onModelsUpdated()
			if (!refreshed) {
				this.modelRefreshStatus = 'error'
				this.modelRefreshError = i18n.t(
					'settings.ai.nutstoreLlmGateway.errors.authorizationRequired',
				)
				return
			}
			this.modelRefreshStatus = 'success'
		} catch (error) {
			if (this.moduleScope.signal.aborted) return
			logger.error(error)
			this.modelRefreshStatus = 'error'
			this.modelRefreshError =
				error instanceof Error
					? error.message
					: i18n.t('settings.ai.nutstoreLlmGateway.errors.refreshFailed')
		} finally {
			if (this.active) {
				this.render()
			}
		}
	}

	private render() {
		if (this.moduleScope.signal.aborted) return
		if (!this.active) {
			return
		}
		const { contentEl } = this
		contentEl.empty()
		const container = contentEl.createDiv({ cls: 'nutstore-llm-usage' })
		const tabList = container.createDiv({
			cls: 'nutstore-llm-gateway__tabs',
		})
		tabList.setAttribute('role', 'tablist')
		this.titleEl.id ||= createId('accessible-label')
		tabList.setAttribute('aria-labelledby', this.titleEl.id)
		this.renderTab(tabList, 'usage', 'usage')
		this.renderTab(tabList, 'models', 'models')

		const panel = container.createDiv({ cls: 'nutstore-llm-gateway__panel' })
		panel.setAttribute('role', 'tabpanel')
		panel.setAttribute('id', GATEWAY_PANEL_ID)
		panel.setAttribute(
			'aria-labelledby',
			`nutstore-llm-gateway-tab-${this.activeTab}`,
		)
		if (this.activeTab === 'models') {
			this.renderModels(panel)
		} else {
			this.renderUsage(panel)
		}
	}

	private renderTab(
		parent: HTMLElement,
		tab: NutstoreLlmGatewayTab,
		label: 'models' | 'usage',
	) {
		const selected = this.activeTab === tab
		const button = new ButtonComponent(parent)
			.setButtonText(i18n.t(`settings.ai.nutstoreLlmGateway.tabs.${label}`))
			.setDisabled(this.isBusy && !selected)
			.onClick(() => this.selectTab(tab))
		button.buttonEl.addClass('nutstore-llm-gateway__tab')
		if (selected) {
			button.buttonEl.addClass('is-active')
		}
		button.buttonEl.setAttribute('id', `nutstore-llm-gateway-tab-${tab}`)
		button.buttonEl.setAttribute('role', 'tab')
		button.buttonEl.setAttribute('aria-selected', String(selected))
		button.buttonEl.setAttribute('aria-controls', GATEWAY_PANEL_ID)
		button.buttonEl.setAttribute('tabindex', selected ? '0' : '-1')
		button.buttonEl.setAttribute('data-nutstore-tab', tab)
		button.buttonEl.addEventListener('keydown', (event) =>
			this.handleTabKeydown(event, tab),
		)
	}

	private renderModels(parent: HTMLElement) {
		const toolbar = parent.createDiv({ cls: 'nutstore-llm-models__toolbar' })
		const heading = toolbar.createDiv({ cls: 'nutstore-llm-models__heading' })
		heading.createDiv({
			cls: 'nutstore-llm-models__title',
			text: i18n.t('settings.ai.nutstoreLlmGateway.models.title'),
		})
		if (this.modelsUpdatedAt) {
			heading.createDiv({
				cls: 'nutstore-llm-usage__updated-at',
				text: i18n.t('settings.ai.nutstoreLlmGateway.models.updatedAt', {
					time: new Date(this.modelsUpdatedAt).toLocaleTimeString(),
				}),
			})
		}
		const actions = toolbar.createDiv({ cls: 'nutstore-llm-usage__actions' })
		const refreshButton = new ButtonComponent(actions)
			.setButtonText(this.getModelRefreshButtonText())
			.setIcon(this.getRefreshIcon(this.modelRefreshStatus, 'refresh-cw'))
			.setDisabled(this.isBusy)
			.onClick(() => void this.updateModels())
		this.setRefreshButtonState(refreshButton.buttonEl, this.modelRefreshStatus)

		if (this.modelRefreshError) {
			parent
				.createDiv({
					cls: 'nutstore-llm-usage__inline-error',
					text: this.modelRefreshError,
				})
				.setAttribute('role', 'alert')
		}
		if (this.modelDiff) {
			this.renderModelDiff(parent, this.modelDiff)
		}

		const models = this.getCurrentModels()
		const listHeading = parent.createDiv({
			cls: 'nutstore-llm-models__list-heading',
		})
		listHeading.createEl('h3', {
			cls: 'nutstore-llm-usage__section-title',
			text: i18n.t('settings.ai.nutstoreLlmGateway.models.available'),
		})
		listHeading.createDiv({
			cls: 'nutstore-llm-models__count',
			text: i18n.t('settings.ai.nutstoreLlmGateway.models.count', {
				count: models.length,
			}),
		})
		if (!models.length) {
			parent.createDiv({
				cls: 'nutstore-llm-usage__state',
				text: i18n.t('settings.ai.nutstoreLlmGateway.models.empty'),
			})
			return
		}
		const list = parent.createDiv({ cls: 'nutstore-llm-models__list' })
		list.setAttribute('role', 'list')
		for (const model of models) {
			const item = list.createDiv({ cls: 'nutstore-llm-models__item' })
			item.setAttribute('role', 'listitem')
			item.createDiv({
				cls: 'nutstore-llm-models__name',
				text: model.name,
			})
			if (model.name !== model.id) {
				item.createEl('code', {
					cls: 'nutstore-llm-models__id',
					text: model.id,
				})
			}
		}
	}

	private getModelRefreshButtonText() {
		switch (this.modelRefreshStatus) {
			case 'loading':
				return i18n.t('settings.ai.nutstoreLlmGateway.usage.updatingModels')
			case 'success':
				return i18n.t('settings.ai.nutstoreLlmGateway.models.refreshed')
			default:
				return i18n.t('settings.ai.nutstoreLlmGateway.refreshModels')
		}
	}

	private getUsageRefreshButtonText() {
		switch (this.usageRefreshStatus) {
			case 'loading':
				return i18n.t('settings.ai.nutstoreLlmGateway.usage.refreshing')
			case 'success':
				return i18n.t('settings.ai.nutstoreLlmGateway.usage.refreshed')
			default:
				return i18n.t('settings.ai.nutstoreLlmGateway.usage.refresh')
		}
	}

	private getRefreshIcon(status: RefreshStatus, idleIcon: string) {
		if (status === 'loading') {
			return 'refresh-cw'
		}
		if (status === 'success') {
			return 'check'
		}
		if (status === 'error') {
			return 'circle-alert'
		}
		return idleIcon
	}

	private setRefreshButtonState(
		button: HTMLButtonElement,
		status: RefreshStatus,
	) {
		button.addClass('connection-button')
		button.addClass('nutstore-llm-usage__refresh-button')
		if (status === 'loading') {
			button.addClass('nutstore-llm-usage__refresh-button--loading')
		} else if (status === 'success') {
			button.addClass('success')
		} else if (status === 'error') {
			button.addClass('error')
		}
	}

	private renderModelDiff(parent: HTMLElement, diff: ModelListDiff) {
		const section = parent.createDiv({ cls: 'nutstore-llm-models__changes' })
		const heading = section.createDiv({
			cls: 'nutstore-llm-models__changes-heading',
		})
		heading.createDiv({
			cls: 'nutstore-llm-usage__section-title',
			text: i18n.t('settings.ai.nutstoreLlmGateway.models.changes'),
		})
		heading.createDiv({
			cls: 'nutstore-llm-models__change-counts',
			text: i18n.t('settings.ai.nutstoreLlmGateway.models.diffSummary', {
				added: diff.added.length,
				removed: diff.removed.length,
			}),
		})
		const hunk = section.createDiv({ cls: 'nutstore-llm-models__hunk' })
		hunk.createDiv({
			cls: 'nutstore-llm-models__hunk-header',
			text: `@@ -${diff.beforeCount} +${diff.afterCount} @@`,
		})
		for (const model of diff.removed) {
			this.renderModelDiffLine(hunk, 'remove', model)
		}
		for (const model of diff.added) {
			this.renderModelDiffLine(hunk, 'add', model)
		}
	}

	private renderModelDiffLine(
		parent: HTMLElement,
		kind: 'add' | 'remove',
		model: ModelSummary,
	) {
		const line = parent.createDiv({
			cls: `nutstore-llm-models__diff-line nutstore-llm-models__diff-line--${kind}`,
		})
		line.createSpan({
			cls: 'nutstore-llm-models__diff-marker',
			text: kind === 'add' ? '+' : '−',
		})
		line.createSpan({
			cls: 'nutstore-llm-models__diff-label',
			text: modelLabel(model),
		})
	}

	private renderUsage(parent: HTMLElement) {
		const toolbar = parent.createDiv({ cls: 'nutstore-llm-usage__toolbar' })
		if (this.usageUpdatedAt) {
			toolbar.createDiv({
				cls: 'nutstore-llm-usage__updated-at',
				text: i18n.t('settings.ai.nutstoreLlmGateway.usage.updatedAt', {
					time: new Date(this.usageUpdatedAt).toLocaleTimeString(),
				}),
			})
		} else {
			toolbar.createDiv({ cls: 'nutstore-llm-usage__updated-at' })
		}
		const actions = toolbar.createDiv({ cls: 'nutstore-llm-usage__actions' })
		const refreshButton = new ButtonComponent(actions)
			.setButtonText(this.getUsageRefreshButtonText())
			.setIcon(this.getRefreshIcon(this.usageRefreshStatus, 'refresh-cw'))
			.setDisabled(this.isBusy)
			.onClick(() => void this.loadUsage())
		this.setRefreshButtonState(refreshButton.buttonEl, this.usageRefreshStatus)

		if (this.usageError && !this.usage) {
			parent
				.createDiv({
					cls: 'nutstore-llm-usage__state nutstore-llm-usage__state--error',
					text: this.usageError,
				})
				.setAttribute('role', 'alert')
			return
		}
		if (!this.usage && this.usageLoading) {
			parent.createDiv({
				cls: 'nutstore-llm-usage__state',
				text: i18n.t('settings.ai.nutstoreLlmGateway.usage.loading'),
			})
			return
		}
		if (!this.usage) {
			return
		}
		if (this.usageError) {
			parent
				.createDiv({
					cls: 'nutstore-llm-usage__inline-error',
					text: this.usageError,
				})
				.setAttribute('role', 'alert')
		}

		const creditUsage = this.usage.credit_usage
		const grantPackages = creditUsage?.grant_packages?.filter(
			(creditPackage) => creditPackage.status === 'active',
		)
		const topupPackages = creditUsage?.topup_packages?.filter(
			(creditPackage) => creditPackage.status === 'active',
		)
		const hasAvailableCredit = typeof this.usage.available_credit === 'number'
		const hasUsage =
			hasAvailableCredit ||
			!!this.usage.unbilled_requests ||
			!!creditUsage?.monthly ||
			(grantPackages?.length ?? 0) > 0 ||
			(topupPackages?.length ?? 0) > 0
		if (!hasUsage) {
			parent.createDiv({
				cls: 'nutstore-llm-usage__state',
				text: i18n.t('settings.ai.nutstoreLlmGateway.usage.empty'),
			})
			return
		}

		const overview = parent.createDiv({ cls: 'nutstore-llm-usage__overview' })
		if (hasAvailableCredit) {
			const summary = overview.createDiv({
				cls: 'nutstore-llm-usage__summary',
			})
			summary.createDiv({
				cls: 'nutstore-llm-usage__summary-label',
				text: i18n.t('settings.ai.nutstoreLlmGateway.usage.availableCredit'),
			})
			summary.createDiv({
				cls: 'nutstore-llm-usage__summary-value',
				text: formatNumber(this.usage.available_credit!),
			})
		}
		const details = overview.createDiv({ cls: 'nutstore-llm-usage__details' })
		if (this.usage.unbilled_requests) {
			const section = this.createSection(
				details,
				i18n.t('settings.ai.nutstoreLlmGateway.usage.requestLimit'),
			)
			this.renderWindow(section, this.usage.unbilled_requests)
		}
		if (creditUsage?.monthly) {
			const section = this.createSection(
				details,
				i18n.t('settings.ai.nutstoreLlmGateway.usage.monthly'),
			)
			this.renderCreditPackage(section, creditUsage.monthly)
		}
		this.renderCreditPackages(
			details,
			grantPackages,
			'settings.ai.nutstoreLlmGateway.usage.grant',
		)
		this.renderCreditPackages(
			details,
			topupPackages,
			'settings.ai.nutstoreLlmGateway.usage.topup',
		)
	}

	private createSection(parent: HTMLElement, title: string) {
		const section = parent.createDiv({ cls: 'nutstore-llm-usage__section' })
		section.createDiv({
			cls: 'nutstore-llm-usage__section-title',
			text: title,
		})
		return section
	}

	private renderWindow(
		parent: HTMLElement,
		window: NutstoreLlmGatewayUsageWindow,
	) {
		const usedPercent = usedPercentage(
			window.remaining_percentage,
			window.limit,
		)
		const card = parent.createDiv({ cls: 'nutstore-llm-usage__card' })
		this.renderProgress(card, usedPercent)
		const metrics = card.createDiv({ cls: 'nutstore-llm-usage__metrics' })
		metrics.createDiv({
			cls: 'nutstore-llm-usage__amount',
			text: i18n.t('settings.ai.nutstoreLlmGateway.usage.requestCount', {
				used: formatNumber(window.used),
				total: formatNumber(window.limit),
			}),
		})
		metrics.createDiv({
			cls: 'nutstore-llm-usage__percentage',
			text: i18n.t('settings.ai.nutstoreLlmGateway.usage.usedPercent', {
				percent: usedPercent,
			}),
		})
		if (window.next_reset_at) {
			card.createDiv({
				cls: 'nutstore-llm-usage__detail',
				text: i18n.t('settings.ai.nutstoreLlmGateway.usage.resetsAt', {
					time: formatDate(window.next_reset_at),
				}),
			})
		}
	}

	private renderCreditPackages(
		container: HTMLElement,
		packages: NutstoreLlmGatewayCreditPackage[] | undefined,
		labelKey:
			| 'settings.ai.nutstoreLlmGateway.usage.grant'
			| 'settings.ai.nutstoreLlmGateway.usage.topup',
	) {
		if (!packages?.length) {
			return
		}
		const section = this.createSection(container, i18n.t(labelKey))
		for (const creditPackage of packages) {
			this.renderCreditPackage(section, creditPackage)
		}
	}

	private renderCreditPackage(
		parent: HTMLElement,
		creditPackage: NutstoreLlmGatewayCreditPackage,
	) {
		const usedPercent = usedPercentage(
			creditPackage.remaining_percentage,
			creditPackage.total_credit,
		)
		const card = parent.createDiv({ cls: 'nutstore-llm-usage__card' })
		this.renderProgress(card, usedPercent)
		const metrics = card.createDiv({ cls: 'nutstore-llm-usage__metrics' })
		metrics.createDiv({
			cls: 'nutstore-llm-usage__amount',
			text: i18n.t('settings.ai.nutstoreLlmGateway.usage.creditAmount', {
				used: formatNumber(creditPackage.used_credit),
				total: formatNumber(creditPackage.total_credit),
			}),
		})
		metrics.createDiv({
			cls: 'nutstore-llm-usage__percentage',
			text: i18n.t('settings.ai.nutstoreLlmGateway.usage.usedPercent', {
				percent: usedPercent,
			}),
		})
		if (creditPackage.expires_at) {
			card.createDiv({
				cls: 'nutstore-llm-usage__detail',
				text: i18n.t('settings.ai.nutstoreLlmGateway.usage.expiresAt', {
					time: formatDate(creditPackage.expires_at),
				}),
			})
		}
	}

	private renderProgress(parent: HTMLElement, percent: number) {
		const bar = parent.createDiv({
			cls: 'nutstore-llm-usage__bar',
		})
		bar.setAttribute('role', 'progressbar')
		bar.setAttribute('aria-valuemin', '0')
		bar.setAttribute('aria-valuemax', '100')
		bar.setAttribute('aria-valuenow', String(percent))
		const label = bar.createSpan({ attr: { hidden: '' } })
		label.id = createId('accessible-label')
		label.setText(
			i18n.t('settings.ai.nutstoreLlmGateway.usage.usedPercent', {
				percent,
			}),
		)
		bar.setAttribute('aria-labelledby', label.id)
		const fill = bar.createDiv({ cls: 'nutstore-llm-usage__bar-fill' })
		fill.style.width = `${percent}%`
	}

	onClose() {
		this.active = false
		this.contentEl.empty()
		this.contentEl.removeClass('nutstore-llm-gateway-modal__content')
		this.modalEl.removeClass('nutstore-llm-gateway-modal')
	}
}
