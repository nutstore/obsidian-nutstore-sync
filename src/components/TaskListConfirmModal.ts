import { App, Modal, Setting } from 'obsidian'
import i18n from '~/i18n'
import getTaskName from '~/utils/get-task-name'
import { BaseTask } from '../sync/tasks/task.interface'

export default class TaskListConfirmModal extends Modal {
	private result: boolean = false
	private selectedTasks: boolean[] = []

	constructor(
		app: App,
		private tasks: BaseTask[],
	) {
		super(app)
		this.selectedTasks = new Array(tasks.length).fill(true)
	}

	onOpen() {
		this.setTitle(i18n.t('taskList.title'))

		const { contentEl } = this
		contentEl.empty()

		const instruction = contentEl.createEl('p')
		instruction.setText(i18n.t('taskList.instruction'))

		const tableContainer = contentEl.createDiv({
			cls: 'max-h-50vh overflow-y-auto',
		})
		const table = tableContainer.createEl('table', { cls: 'task-list-table' })

		const thead = table.createEl('thead')
		const headerRow = thead.createEl('tr')
		headerRow.createEl('th', { text: i18n.t('taskList.execute') })
		headerRow.createEl('th', { text: i18n.t('taskList.action') })
		headerRow.createEl('th', { text: i18n.t('taskList.localPath') })
		headerRow.createEl('th', { text: i18n.t('taskList.remotePath') })

		const tbody = table.createEl('tbody')
		this.tasks.forEach((task, index) => {
			const row = tbody.createEl('tr')
			const checkboxCell = row.createEl('td')
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
			row.createEl('td', { text: getTaskName(task) })
			row.createEl('td', { text: task.localPath })
			row.createEl('td', { text: task.remotePath })
		})

		const settingDiv = contentEl.createDiv()
		settingDiv.style.marginTop = '1rem'
		new Setting(settingDiv)
			.addButton((button) => {
				button
					.setButtonText(i18n.t('taskList.continue'))
					.setCta()
					.onClick(() => {
						this.result = true
						this.close()
					})
			})
			.addButton((button) => {
				button.setButtonText(i18n.t('taskList.cancel')).onClick(() => {
					this.result = false
					this.close()
				})
			})
	}

	async open(): Promise<{ confirm: boolean; tasks: BaseTask[] }> {
		super.open()
		return new Promise((resolve) => {
			this.onClose = () => {
				const selectedTasks = this.tasks.filter(
					(_, index) => this.selectedTasks[index],
				)
				resolve({
					confirm: this.result,
					tasks: selectedTasks,
				})
			}
		})
	}
}
