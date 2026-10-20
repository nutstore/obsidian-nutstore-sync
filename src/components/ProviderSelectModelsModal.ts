import { Modal, Notice } from 'obsidian'
import {
	applyObsidianModalMountTarget,
	type ChatModalMountTarget,
} from '~/ai/chat/ui/modal-mount'
import type { DiscoveredModel } from '~/ai/catalog/fetch-models'
import { compareModelIds } from '~/ai/catalog/config'
import i18n from '~/i18n'
import { addClassTokens, removeClassTokens } from '~/utils/class-tokens'
import { isFuzzySubsequenceMatch } from '~/utils/fuzzy-match'
import type NutstorePlugin from '..'

export default class ProviderSelectModelsModal extends Modal {
	private cleanupModalMount?: () => void
	private selectedIds = new Set<string>()
	private searchQuery = ''
	private filteredModels: DiscoveredModel[] = []
	private listEl?: HTMLElement
	private selectAllButton?: HTMLButtonElement
	private readonly models: DiscoveredModel[]

	constructor(
		plugin: NutstorePlugin,
		models: DiscoveredModel[],
		private readonly onAdd: (selected: DiscoveredModel[]) => void,
		private readonly mountTarget?: ChatModalMountTarget,
	) {
		super(plugin.app)
		plugin.ai.lifecycle.scope.ownModal(this)
		this.models = [...models].sort((a, b) => compareModelIds(a.id, b.id))
		this.filteredModels = [...this.models]
	}

	onOpen() {
		addClassTokens(this.modalEl, ':uno: provider-select-models-modal')
		addClassTokens(
			this.contentEl,
			':uno: provider-select-models-modal__content',
		)
		this.render()
	}

	private render() {
		const { contentEl } = this
		contentEl.empty()

		contentEl.createEl('h2', {
			text: i18n.t('settings.ai.models.selectModelsTitle'),
		})
		contentEl.createEl('p', {
			text: i18n.t('settings.ai.models.selectModelsDesc'),
			cls: ':uno: text-sm text-[var(--text-muted)] mb-3',
		})

		const searchRow = contentEl.createDiv({
			cls: ':uno: flex items-center gap-3 mb-3',
		})

		const searchInput = searchRow.createEl('input', {
			type: 'text',
			cls: ':uno: flex-1 px-3 py-1.5 rounded border border-[var(--background-modifier-border)] bg-[var(--background-modifier-form-field)] text-sm outline-none',
			attr: {
				placeholder: i18n.t('settings.ai.models.searchPlaceholder'),
			},
		})
		searchInput.value = this.searchQuery
		searchInput.addEventListener('input', () => {
			this.searchQuery = searchInput.value
			this.updateFilteredList()
		})

		this.selectAllButton = searchRow.createEl('button', {
			type: 'button',
			text: this.getSelectAllButtonText(),
			cls: ':uno: text-sm cursor-pointer px-2 py-1 bg-transparent border-none text-[var(--text-muted)] hover:text-[var(--text-normal)] select-none whitespace-nowrap',
		})
		this.selectAllButton.addEventListener('click', () => {
			this.handleSelectAllToggle()
		})

		this.listEl = contentEl.createDiv({
			cls: ':uno: provider-select-models__list flex-1 min-h-0 max-h-60vh overflow-y-auto flex flex-col gap-0.5 pr-1',
		})

		this.renderListItems()

		const footerEl = contentEl.createDiv({
			cls: ':uno: flex justify-end gap-3 pt-3 mt-3 border-t border-[var(--background-modifier-border)]',
		})

		const cancelBtn = footerEl.createEl('button', {
			type: 'button',
			text: i18n.t('settings.filters.cancel'),
		})
		cancelBtn.addEventListener('click', () => this.close())

		const addBtn = footerEl.createEl('button', {
			type: 'button',
			text: i18n.t('settings.ai.models.addSelected'),
			cls: ':uno: mod-cta',
		})
		addBtn.addEventListener('click', () => {
			if (this.selectedIds.size === 0) {
				new Notice(i18n.t('settings.ai.models.noModelsSelected'))
				return
			}
			const selected = this.models.filter((m) => this.selectedIds.has(m.id))
			this.onAdd(selected)
			this.close()
		})
	}

	private updateFilteredList() {
		const q = this.searchQuery.trim()
		if (!q) {
			this.filteredModels = [...this.models]
		} else {
			this.filteredModels = this.models.filter(
				(m) =>
					isFuzzySubsequenceMatch(q, m.id) ||
					(m.name ? isFuzzySubsequenceMatch(q, m.name) : false),
			)
		}
		this.updateSelectAllButtonText()
		this.renderListItems()
	}

	private isAllVisibleSelected(): boolean {
		if (this.filteredModels.length === 0) return false
		return this.filteredModels.every((m) => this.selectedIds.has(m.id))
	}

	private getSelectAllButtonText(): string {
		return this.isAllVisibleSelected()
			? i18n.t('settings.ai.models.deselectAll')
			: i18n.t('settings.ai.models.selectAll')
	}

	private updateSelectAllButtonText() {
		if (this.selectAllButton) {
			this.selectAllButton.textContent = this.getSelectAllButtonText()
		}
	}

	private handleSelectAllToggle() {
		if (this.filteredModels.length === 0) return
		if (this.isAllVisibleSelected()) {
			for (const m of this.filteredModels) {
				this.selectedIds.delete(m.id)
			}
		} else {
			for (const m of this.filteredModels) {
				this.selectedIds.add(m.id)
			}
		}
		this.updateSelectAllButtonText()
		this.renderListItems()
	}

	private renderListItems() {
		if (!this.listEl) return
		this.listEl.empty()

		if (this.filteredModels.length === 0) {
			this.listEl.createDiv({
				text: i18n.t('settings.ai.models.noMatchingModels'),
				cls: ':uno: text-sm text-[var(--text-muted)] text-center py-6',
			})
			return
		}

		for (const model of this.filteredModels) {
			const isChecked = this.selectedIds.has(model.id)
			const row = this.listEl.createEl('label', {
				cls: ':uno: flex items-center gap-2.5 py-1.5 px-2 rounded cursor-pointer hover:bg-[var(--background-modifier-hover)] select-none transition-colors duration-100',
			})

			const checkbox = row.createEl('input', {
				type: 'checkbox',
				cls: ':uno: cursor-pointer flex-shrink-0',
			})
			checkbox.checked = isChecked

			checkbox.addEventListener('change', () => {
				if (checkbox.checked) {
					this.selectedIds.add(model.id)
				} else {
					this.selectedIds.delete(model.id)
				}
				this.updateSelectAllButtonText()
			})

			row.createSpan({
				text: model.id,
				cls: ':uno: font-mono text-sm break-all flex-1 text-[var(--text-normal)]',
			})
		}
	}

	open() {
		super.open()
		this.cleanupModalMount = applyObsidianModalMountTarget(
			this,
			this.mountTarget,
		)
	}

	onClose() {
		this.cleanupModalMount?.()
		this.cleanupModalMount = undefined
		removeClassTokens(this.modalEl, ':uno: provider-select-models-modal')
		removeClassTokens(
			this.contentEl,
			':uno: provider-select-models-modal__content',
		)
		this.contentEl.empty()
	}
}
