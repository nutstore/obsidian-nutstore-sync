import { App, Modal, Setting } from 'obsidian'
import i18n from '~/i18n'
import getTaskName from '~/utils/get-task-name'
import {
	mountTaskSelectionVirtualList,
	type TaskSelectionItem,
	type TaskSelectionVirtualListController,
} from '../components/solid-js'
import { BaseTask } from '../sync/tasks/task.interface'

export default class TaskListConfirmModal extends Modal {
	private result: boolean = false
	private selectedTasks: boolean[] = []
	private listController?: TaskSelectionVirtualListController
	private resolveOpen?: (value: { confirm: boolean; tasks: BaseTask[] }) => void

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

		const listContainer = contentEl.createDiv({
			cls: 'h-[50vh] max-h-[50vh] min-h-[16rem] w-full',
		})
		const onToggle = (index: number, checked: boolean) => {
			this.selectedTasks[index] = checked
			this.listController?.update({
				items: this.buildListItems(),
				onToggle,
				onToggleAll,
			})
		}
		const onToggleAll = (checked: boolean) => {
			this.selectedTasks.fill(checked)
			this.listController?.update({
				items: this.buildListItems(),
				onToggle,
				onToggleAll,
			})
		}
		this.listController = mountTaskSelectionVirtualList(listContainer, {
			items: this.buildListItems(),
			onToggle,
			onToggleAll,
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
		return new Promise((resolve) => {
			this.resolveOpen = resolve
			super.open()
		})
	}

	onClose() {
		this.listController?.destroy()
		this.listController = undefined
		const selectedTasks = this.tasks.filter(
			(_, index) => this.selectedTasks[index],
		)
		this.resolveOpen?.({
			confirm: this.result,
			tasks: selectedTasks,
		})
		this.resolveOpen = undefined
		this.contentEl.empty()
	}

	private buildListItems(): TaskSelectionItem[] {
		return this.tasks.map((task, index) => ({
			id: `${index}-${task.localPath}-${task.remotePath}`,
			action: getTaskName(task),
			localPath: task.localPath,
			remotePath: task.remotePath,
			checked: this.selectedTasks[index],
		}))
	}
}
