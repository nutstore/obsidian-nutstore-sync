import { App, Modal, Setting } from 'obsidian'
import i18n from '~/i18n'
import type { SyncTaskRecord } from '~/services/progress.service'
import { getTaskLabel } from '~/utils/get-task-name'

/** The failed tasks of a run, as recorded in its snapshot. */
export default class FailedTasksModal extends Modal {
	constructor(
		app: App,
		private failedTasks: readonly SyncTaskRecord[],
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
			row.createEl('td', { text: getTaskLabel(task) })
			row.createEl('td', { text: task.localPath })
			row.createEl('td', { text: task.error ?? '' })
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
