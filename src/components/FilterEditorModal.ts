import { cloneDeep } from 'lodash-es'
import { App, Modal, Setting } from 'obsidian'
import i18n from '~/i18n'
import { getExpr, getUserOptions, GlobMatchOptions } from '~/utils/glob-match'

export default class FilterEditorModal extends Modal {
	filters: GlobMatchOptions[]

	constructor(
		app: App,
		filters: GlobMatchOptions[] = [],
		private onSave: (filters: GlobMatchOptions[]) => void,
	) {
		super(app)
		this.filters = cloneDeep(filters)
	}

	onOpen() {
		const { contentEl } = this
		contentEl.empty()

		contentEl.createEl('h2', { text: i18n.t('settings.filters.edit') })
		contentEl.createEl('p', {
			text: i18n.t('settings.filters.description'),
			cls: 'setting-item-description',
		})

		const listContainer = contentEl.createDiv({
			cls: 'flex flex-col gap-2 pb-2',
		})

		const updateList = () => {
			listContainer.empty()
			this.filters.forEach((_filter, index) => {
				const filter = {
					expr: getExpr(_filter),
					options: getUserOptions(_filter),
				}
				this.filters[index] = filter
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
				itemContainer.appendChild(input)
				itemContainer.appendChild(forceCaseBtn)
				itemContainer.appendChild(trash)
			})
		}

		updateList()

		new Setting(contentEl).addButton((button) => {
			button.setButtonText(i18n.t('settings.filters.add')).onClick(() => {
				this.filters.push('')
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
