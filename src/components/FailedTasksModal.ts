import { App, Modal, Setting } from 'obsidian'
import i18n from '~/i18n'

interface FailedTaskInfo {
	taskName: string
	localPath: string
	errorMessage: string
}

export default class FailedTasksModal extends Modal {
	constructor(
		app: App,
		private failedTasks: FailedTaskInfo[],
	) {
		super(app)
	}

	onOpen() {
		this.setTitle(i18n.t('failedTasks.title'))

		const { contentEl } = this
		contentEl.empty()

		contentEl.createEl('p', {
			cls: ':uno: whitespace-pre-wrap',
			text: i18n.t('failedTasks.instruction'),
		})

		const tableContainer = contentEl.createDiv({
			cls: ':uno: max-h-50vh overflow-y-auto',
		})
		const table = tableContainer.createEl('table', {
			cls: ':uno: task-list-table',
		})

		const thead = table.createEl('thead')
		const headerRow = thead.createEl('tr')
		headerRow.createEl('th', { text: i18n.t('failedTasks.taskName') })
		headerRow.createEl('th', { text: i18n.t('failedTasks.localPath') })
		headerRow.createEl('th', { text: i18n.t('failedTasks.errorMessage') })

		const tbody = table.createEl('tbody')
		this.failedTasks.forEach((task) => {
			const row = tbody.createEl('tr')
			row.createEl('td', { text: task.taskName })
			row.createEl('td', { text: task.localPath })
			row.createEl('td', { text: task.errorMessage })
		})

		const settingDiv = contentEl.createDiv({ cls: ':uno: mt-4' })
		new Setting(settingDiv).addButton((button) => {
			button
				.setButtonText(i18n.t('failedTasks.close'))
				.setCta()
				.onClick(() => this.close())
		})
	}

	onClose() {
		const { contentEl } = this
		contentEl.empty()
	}
}

export type { FailedTaskInfo }
