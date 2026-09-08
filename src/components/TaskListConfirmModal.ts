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
		this.selectedTasks = Array.from({ length: tasks.length }, () => true)
	}

	onOpen() {
		this.setTitle(i18n.t('taskList.title'))

		const { contentEl } = this
		contentEl.empty()

		const listContainer = contentEl.createDiv({
			cls: ':uno: h-[60vh] min-h-[16rem] w-full',
		})
		let updateContinueButtonText = () => {}
		const updateList = () => {
			this.listController?.update({
				items: this.buildListItems(),
				onToggle,
				onToggleMany,
			})
			updateContinueButtonText()
		}
		const onToggle = (index: number, checked: boolean) => {
			this.selectedTasks[index] = checked
			updateList()
		}
		const onToggleMany = (indices: number[], checked: boolean) => {
			for (const index of indices) {
				this.selectedTasks[index] = checked
			}
			updateList()
		}
		this.listController = mountTaskSelectionVirtualList(listContainer, {
			items: this.buildListItems(),
			onToggle,
			onToggleMany,
		})

		const settingDiv = contentEl.createDiv({ cls: ':uno: mt-4' })
		new Setting(settingDiv)
			.addButton((button) => {
				updateContinueButtonText = () => {
					button.setButtonText(
						i18n.t('taskList.continue', {
							count: this.selectedTasks.filter(Boolean).length,
						}),
					)
				}
				updateContinueButtonText()
				button.setCta().onClick(() => {
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

	openAndWait(): Promise<{ confirm: boolean; tasks: BaseTask[] }> {
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
