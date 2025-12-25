import { App, Modal, Setting } from 'obsidian'
import i18n from '~/i18n'
import RemoveLocalTask from '../sync/tasks/remove-local.task'

export default class DeleteConfirmModal extends Modal {
	private confirmed: boolean = false
	private selectedTasks: boolean[] = []

	constructor(
		app: App,
		private tasks: RemoveLocalTask[],
	) {
		super(app)
		this.selectedTasks = new Array(tasks.length).fill(true)
	}

	onOpen() {
		this.setTitle(i18n.t('deleteConfirm.title'))

		const { contentEl } = this
		contentEl.empty()

		const instruction = contentEl.createEl('p', {
			cls: 'delete-confirm-instruction',
		})
		instruction.style.whiteSpace = 'pre-wrap'
		instruction.setText(i18n.t('deleteConfirm.instruction'))

		const tableContainer = contentEl.createDiv({
			cls: 'max-h-50vh overflow-y-auto',
		})
		const table = tableContainer.createEl('table', { cls: 'task-list-table' })

		const thead = table.createEl('thead')
		const headerRow = thead.createEl('tr')
		const selectHeader = headerRow.createEl('th', {
			text: i18n.t('deleteConfirm.select'),
		})
		selectHeader.style.textAlign = 'center'
		headerRow.createEl('th', { text: i18n.t('deleteConfirm.filePath') })

		const tbody = table.createEl('tbody')
		this.tasks.forEach((task, index) => {
			const row = tbody.createEl('tr')
			const checkboxCell = row.createEl('td')
			checkboxCell.style.textAlign = 'center'
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

		const settingDiv = contentEl.createDiv()
		settingDiv.style.marginTop = '1rem'
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

	async open(): Promise<{
		tasksToDelete: RemoveLocalTask[]
		tasksToReupload: RemoveLocalTask[]
	}> {
		super.open()
		return new Promise((resolve) => {
			this.onClose = () => {
				if (!this.confirmed) {
					// User cancelled, no changes
					resolve({
						tasksToDelete: [],
						tasksToReupload: [],
					})
					return
				}
				const tasksToDelete = this.tasks.filter(
					(_, index) => this.selectedTasks[index],
				)
				const tasksToReupload = this.tasks.filter(
					(_, index) => !this.selectedTasks[index],
				)
				resolve({
					tasksToDelete,
					tasksToReupload,
				})
			}
		})
	}
}
