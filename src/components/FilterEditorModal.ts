import { App, Modal, Setting } from 'obsidian'
import i18n from '../i18n'

export default class FilterEditorModal extends Modal {
	filters: string[]
	onSave: (filters: string[]) => void

	constructor(
		app: App,
		filters: string[] = [],
		onSave: (filters: string[]) => void,
	) {
		super(app)
		this.filters = [...filters]
		this.onSave = onSave
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
			this.filters.forEach((filter, index) => {
				const itemContainer = listContainer.createDiv({
					cls: 'flex gap-2',
				})
				const input = listContainer.createEl('input', {
					type: 'text',
					cls: 'flex-1',
					placeholder: i18n.t('settings.filters.placeholder'),
					value: filter,
				})
				input.spellcheck = false
				input.addEventListener('input', () => {
					this.filters[index] = input.value
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
