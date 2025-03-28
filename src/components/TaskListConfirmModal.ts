import { App, Modal, Setting } from 'obsidian'
import i18n from '~/i18n'
import MkdirLocalTask from '~/sync/tasks/mkdir-local.task'
import MkdirRemoteTask from '~/sync/tasks/mkdir-remote.task'
import PullTask from '~/sync/tasks/pull.task'
import PushTask from '~/sync/tasks/push.task'
import RemoveLocalTask from '~/sync/tasks/remove-local.task'
import RemoveRemoteTask from '~/sync/tasks/remove-remote.task'
import ConflictResolveTask from '../sync/tasks/conflict-resolve.task'
import { BaseTask } from '../sync/tasks/task.interface'

export class TaskListConfirmModal extends Modal {
	private result: boolean = false
	private selectedTasks: boolean[] = []

	constructor(
		app: App,
		private tasks: BaseTask[],
	) {
		super(app)
		this.selectedTasks = new Array(tasks.length).fill(true)
	}

	private getTaskAction(task: BaseTask): string {
		if (task instanceof ConflictResolveTask) {
			return i18n.t('taskList.actions.merge')
		}
		if (task instanceof MkdirLocalTask) {
			return i18n.t('taskList.actions.createLocalDir')
		}
		if (task instanceof MkdirRemoteTask) {
			return i18n.t('taskList.actions.createRemoteDir')
		}
		if (task instanceof PullTask) {
			return i18n.t('taskList.actions.download')
		}
		if (task instanceof PushTask) {
			return i18n.t('taskList.actions.upload')
		}
		if (task instanceof RemoveLocalTask) {
			return i18n.t('taskList.actions.removeLocal')
		}
		if (task instanceof RemoveRemoteTask) {
			return i18n.t('taskList.actions.removeRemote')
		}
		return i18n.t('taskList.actions.sync')
	}

	onOpen() {
		this.setTitle(i18n.t('taskList.title'))

		const { contentEl } = this
		contentEl.empty()

		const table = contentEl.createEl('table', { cls: 'task-list-table' })

		// header
		const thead = table.createEl('thead')
		const headerRow = thead.createEl('tr')
		headerRow.createEl('th', { text: i18n.t('taskList.execute') })
		headerRow.createEl('th', { text: i18n.t('taskList.action') })
		headerRow.createEl('th', { text: i18n.t('taskList.localPath') })
		headerRow.createEl('th', { text: i18n.t('taskList.remotePath') })

		// body
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
			row.createEl('td', { text: this.getTaskAction(task) })
			row.createEl('td', { text: task.localPath })
			row.createEl('td', { text: task.remotePath })
		})

		new Setting(contentEl)
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
