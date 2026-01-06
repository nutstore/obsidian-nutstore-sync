import { cloneDeep } from 'lodash-es'
import { Modal, Setting } from 'obsidian'
import i18n from '~/i18n'
import { getUserOptions, GlobMatchOptions } from '~/utils/glob-match'
import NutstorePlugin from '..'

enum FilterType {
	Include = 'include',
	Exclude = 'exclude',
}

export default class FilterEditorModal extends Modal {
	static readonly FilterType = FilterType

	filters: GlobMatchOptions[]

	constructor(
		private plugin: NutstorePlugin,
		filters: GlobMatchOptions[] = [],
		private onSave: (filters: GlobMatchOptions[]) => void,
		private filterType: FilterType = FilterType.Exclude,
	) {
		super(plugin.app)
		this.filters = cloneDeep(filters)
	}

	onOpen() {
		const { contentEl } = this
		contentEl.empty()

		const titleKey =
			this.filterType === FilterType.Include
				? 'settings.filters.include.name'
				: 'settings.filters.exclude.name'
		const descKey =
			this.filterType === FilterType.Include
				? 'settings.filters.include.desc'
				: 'settings.filters.exclude.desc'

		contentEl.createEl('h2', { text: i18n.t(titleKey) })
		contentEl.createEl('p', {
			text: i18n.t(descKey),
			cls: 'setting-item-description',
		})

		const listContainer = contentEl.createDiv({
			cls: 'flex flex-col gap-2 pb-2',
		})

		const updateList = () => {
			listContainer.empty()
			this.filters.forEach((filter, index) => {
				const itemContainer = listContainer.createDiv({
					cls: 'flex gap-2',
				})
				const input = listContainer.createEl('input', {
					type: 'text',
					cls: 'flex-1',
					placeholder: i18n.t('settings.filters.placeholder'),
					value: filter.expr,
				})
				input.spellcheck = false
				input.addEventListener('input', () => {
					filter.expr = input.value
					this.filters[index] = filter
				})
				const forceCaseBtn = listContainer.createEl('button', {
					text: 'Aa',
					cls: 'shadow-none!',
				})
				function updateButtonStatus() {
					const opt = getUserOptions(filter)
					const activeCls = ['bg-[var(--interactive-accent)]!']
					const inactiveCls = [
						'background-none!',
						'hover:bg-[--interactive-normal]!',
					]
					if (opt.caseSensitive) {
						forceCaseBtn.classList.add(...activeCls)
						forceCaseBtn.classList.remove(...inactiveCls)
					} else {
						forceCaseBtn.classList.remove(...activeCls)
						forceCaseBtn.classList.add(...inactiveCls)
					}
				}
				updateButtonStatus()
				forceCaseBtn.addEventListener('click', () => {
					filter.options.caseSensitive = !filter.options.caseSensitive
					updateButtonStatus()
				})
				const trash = listContainer.createEl('button', {
					text: i18n.t('settings.filters.remove'),
				})
				let confirmDelete = false
				trash.addEventListener('click', () => {
					if (!confirmDelete) {
						confirmDelete = true
						trash.setText(i18n.t('settings.filters.confirmRemove'))
						trash.addClass('mod-warning')
					} else {
						this.filters.splice(index, 1)
						updateList()
					}
				})
				trash.addEventListener('blur', () => {
					confirmDelete = false
					trash.setText(i18n.t('settings.filters.remove'))
					trash.removeClass('mod-warning')
				})
				itemContainer.appendChild(input)
				itemContainer.appendChild(forceCaseBtn)
				itemContainer.appendChild(trash)
			})
		}

		updateList()

		new Setting(contentEl).addButton((button) => {
			button.setButtonText(i18n.t('settings.filters.add')).onClick(() => {
				this.filters.push({
					expr: '',
					options: {
						caseSensitive: false,
					},
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
						this.onSave(this.filters)
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
