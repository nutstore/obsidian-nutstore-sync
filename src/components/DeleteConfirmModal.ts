import { App, Modal, Setting } from 'obsidian'
import i18n from '~/i18n'
import RemoveLocalTask from '../sync/tasks/remove-local.task'

interface DeleteSelection {
	tasksToDelete: RemoveLocalTask[]
	tasksToReupload: RemoveLocalTask[]
}

export default class DeleteConfirmModal extends Modal {
	private resolve?: (selection: DeleteSelection) => void
	private confirmed: boolean = false
	private selectedTasks: boolean[] = []

	constructor(
		app: App,
		private tasks: RemoveLocalTask[],
	) {
		super(app)
		this.selectedTasks = Array.from({ length: tasks.length }, () => true)
	}

	onOpen() {
		this.setTitle(i18n.t('deleteConfirm.title'))

		const { contentEl } = this
		contentEl.empty()

		const instruction = contentEl.createEl('p', {
			cls: ':uno: whitespace-pre-wrap',
		})
		instruction.setText(i18n.t('deleteConfirm.instruction'))

		const tableContainer = contentEl.createDiv({
			cls: ':uno: max-h-50vh overflow-y-auto',
		})
		const table = tableContainer.createEl('table', {
			cls: ':uno: task-list-table',
		})

		const thead = table.createEl('thead')
		const headerRow = thead.createEl('tr')
		headerRow.createEl('th', {
			cls: ':uno: text-center',
			text: i18n.t('deleteConfirm.select'),
		})
		headerRow.createEl('th', { text: i18n.t('deleteConfirm.filePath') })

		const tbody = table.createEl('tbody')
		this.tasks.forEach((task, index) => {
			const row = tbody.createEl('tr')
			const checkboxCell = row.createEl('td', {
				cls: ':uno: text-center',
			})
			const checkbox = checkboxCell.createEl('input')
			checkbox.type = 'checkbox'
			checkbox.checked = this.selectedTasks[index]
			checkbox.addEventListener('change', (e) => {
				this.selectedTasks[index] = checkbox.checked
				e.stopPropagation()
			})
			row.addEventListener('click', (e) => {
				if (e.target === checkbox) {
					return
				}
				checkbox.checked = !checkbox.checked
				this.selectedTasks[index] = checkbox.checked
				e.stopPropagation()
			})
			row.createEl('td', { text: task.localPath })
		})

		const settingDiv = contentEl.createDiv({ cls: ':uno: mt-4' })
		new Setting(settingDiv)
			.addButton((button) => {
				button
					.setButtonText(i18n.t('deleteConfirm.deleteAndReupload'))
					.setCta()
					.onClick(() => {
						this.confirmed = true
						this.close()
					})
			})
			.addButton((button) => {
				button.setButtonText(i18n.t('deleteConfirm.skipForNow')).onClick(() => {
					this.confirmed = false
					this.close()
				})
			})
	}

	openAndWait(): Promise<DeleteSelection> {
		return new Promise((resolve) => {
			this.resolve = resolve
			super.open()
		})
	}

	onClose() {
		this.resolve?.({
			tasksToDelete: this.confirmed
				? this.tasks.filter((_, index) => this.selectedTasks[index])
				: [],
			tasksToReupload: this.confirmed
				? this.tasks.filter((_, index) => !this.selectedTasks[index])
				: [],
		})
		this.resolve = undefined
		this.contentEl.empty()
	}
}
