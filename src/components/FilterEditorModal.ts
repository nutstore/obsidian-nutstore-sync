import { cloneDeep } from 'lodash-es'
import { Modal, Setting } from 'obsidian'
import i18n from '~/i18n'
import { addClassTokens, removeClassTokens } from '~/utils/class-tokens'
import {
	FilterRuleType,
	getUserOptions,
	GlobFilterRule,
} from '~/utils/glob-match'
import NutstorePlugin from '..'

export default class FilterEditorModal extends Modal {
	rules: GlobFilterRule[]

	constructor(
		plugin: NutstorePlugin,
		rules: GlobFilterRule[] = [],
		private onSave: (filters: GlobFilterRule[]) => void | Promise<void>,
		private getHighlightedRule?: (
			rules: GlobFilterRule[],
		) => GlobFilterRule | undefined,
	) {
		super(plugin.app)
		this.rules = cloneDeep(rules)
	}

	onOpen() {
		const { contentEl } = this
		contentEl.empty()

		contentEl.createEl('h2', {
			text: i18n.t('settings.filters.name'),
		})
		contentEl.createEl('p', {
			text: i18n.t('settings.filters.desc'),
			cls: ':uno: setting-item-description',
		})

		const listContainer = contentEl.createDiv({
			cls: ':uno: flex flex-col gap-2 pb-2',
		})

		const rows: Array<{ rule: GlobFilterRule; container: HTMLElement }> = []
		const refreshHighlight = () => {
			const highlightedRule = this.getHighlightedRule?.(this.rules)
			for (const { rule, container } of rows) {
				if (rule === highlightedRule) {
					addClassTokens(container, ':uno: ns-filter-rule-conflict')
				} else {
					removeClassTokens(container, ':uno: ns-filter-rule-conflict')
				}
			}
		}
		const updateList = () => {
			listContainer.empty()
			rows.length = 0
			this.rules.forEach((rule, index) => {
				const itemContainer = listContainer.createDiv({
					cls: ':uno: flex gap-2 items-center ns-filter-rule-row',
				})
				rows.push({ rule, container: itemContainer })
				const activeToggle = listContainer.createEl('input', {
					type: 'checkbox',
					cls: ':uno: cursor-pointer self-center',
				})
				activeToggle.checked = rule.disabled !== true
				activeToggle.title = i18n.t('settings.filters.toggle')
				const updateRowState = () => {
					if (rule.disabled === true) {
						addClassTokens(itemContainer, ':uno: opacity-50')
					} else {
						removeClassTokens(itemContainer, ':uno: opacity-50')
					}
				}
				updateRowState()
				activeToggle.addEventListener('change', () => {
					if (activeToggle.checked) {
						delete rule.disabled
					} else {
						rule.disabled = true
					}
					this.rules[index] = rule
					updateRowState()
					refreshHighlight()
				})
				const typeSelect = listContainer.createEl('select', {
					cls: ':uno: shadow-none!',
				})
				typeSelect.addClass('ns-filter-type')
				for (const type of ['exclude', 'include'] as FilterRuleType[]) {
					const option = typeSelect.createEl('option', {
						value: type,
						text:
							type === 'exclude'
								? i18n.t('settings.filters.types.exclude')
								: i18n.t('settings.filters.types.include'),
					})
					option.selected = rule.type === type
				}
				typeSelect.addEventListener('change', () => {
					rule.type = typeSelect.value as FilterRuleType
					this.rules[index] = rule
					refreshHighlight()
				})

				const input = listContainer.createEl('input', {
					type: 'text',
					cls: ':uno: flex-1',
					placeholder: i18n.t('settings.filters.placeholder'),
					value: rule.expr,
				})
				input.spellcheck = false
				input.addEventListener('input', () => {
					rule.expr = input.value
					this.rules[index] = rule
					refreshHighlight()
				})

				const controls = itemContainer.createDiv({
					cls: ':uno: flex gap-2 items-center ns-filter-controls',
				})

				const upBtn = controls.createEl('button', {
					text: '↑',
					cls: ':uno: shadow-none!',
				})
				upBtn.disabled = index === 0
				upBtn.addEventListener('click', () => {
					if (index === 0) {
						return
					}
					this.rules.splice(index - 1, 0, this.rules.splice(index, 1)[0])
					updateList()
				})

				const downBtn = controls.createEl('button', {
					text: '↓',
					cls: ':uno: shadow-none!',
				})
				downBtn.disabled = index === this.rules.length - 1
				downBtn.addEventListener('click', () => {
					if (index === this.rules.length - 1) {
						return
					}
					this.rules.splice(index + 1, 0, this.rules.splice(index, 1)[0])
					updateList()
				})

				const forceCaseBtn = controls.createEl('button', {
					text: 'Aa',
					cls: ':uno: shadow-none!',
				})
				function updateButtonStatus() {
					const opt = getUserOptions(rule)
					const activeCls = [':uno: bg-[var(--interactive-accent)]!']
					const inactiveCls = [
						'background-none!',
						'hover:bg-[--interactive-normal]!',
					]
					if (opt.caseSensitive) {
						addClassTokens(forceCaseBtn, ...activeCls)
						removeClassTokens(forceCaseBtn, ...inactiveCls)
					} else {
						removeClassTokens(forceCaseBtn, ...activeCls)
						addClassTokens(forceCaseBtn, ...inactiveCls)
					}
				}
				updateButtonStatus()
				forceCaseBtn.addEventListener('click', () => {
					rule.options.caseSensitive = !rule.options.caseSensitive
					updateButtonStatus()
				})

				const trash = controls.createEl('button', {
					text: i18n.t('settings.filters.remove'),
				})
				let confirmDelete = false
				trash.addEventListener('click', () => {
					if (!confirmDelete) {
						confirmDelete = true
						trash.setText(i18n.t('settings.filters.confirmRemove'))
						addClassTokens(trash, ':uno: mod-warning')
					} else {
						this.rules.splice(index, 1)
						updateList()
					}
				})
				trash.addEventListener('blur', () => {
					confirmDelete = false
					trash.setText(i18n.t('settings.filters.remove'))
					removeClassTokens(trash, ':uno: mod-warning')
				})
				itemContainer.appendChild(activeToggle)
				itemContainer.appendChild(typeSelect)
				itemContainer.appendChild(input)
				itemContainer.appendChild(controls)
			})
			refreshHighlight()
		}

		updateList()

		new Setting(contentEl).addButton((button) => {
			button.setButtonText(i18n.t('settings.filters.add')).onClick(() => {
				this.rules.push({
					expr: '',
					options: {
						caseSensitive: false,
					},
					type: 'exclude',
				})
				updateList()
			})
		})

		new Setting(contentEl)
			.addButton((button) => {
				button
					.setButtonText(i18n.t('settings.filters.save'))
					.setCta()
					.onClick(() => {
						void this.onSave(this.rules)
						this.close()
					})
			})
			.addButton((button) => {
				button.setButtonText(i18n.t('settings.filters.cancel')).onClick(() => {
					this.close()
				})
			})
	}

	onClose() {
		const { contentEl } = this
		contentEl.empty()
	}
}
