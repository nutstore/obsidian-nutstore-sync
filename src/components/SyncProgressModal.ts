import { Modal, setIcon } from 'obsidian'
import NutstorePlugin from '..'
import i18n from '../i18n'
import ConflictResolveTask from '../sync/tasks/conflict-resolve.task'
import MkdirLocalTask from '../sync/tasks/mkdir-local.task'
import MkdirRemoteTask from '../sync/tasks/mkdir-remote.task'
import PullTask from '../sync/tasks/pull.task'
import PushTask from '../sync/tasks/push.task'
import RemoveLocalTask from '../sync/tasks/remove-local.task'
import RemoveRemoteTask from '../sync/tasks/remove-remote.task'

export default class SyncProgressModal extends Modal {
	private progressBar: HTMLDivElement
	private progressText: HTMLDivElement
	private progressStats: HTMLDivElement
	private currentFile: HTMLDivElement
	private filesList: HTMLDivElement

	constructor(
		private plugin: NutstorePlugin,
		private closeCallback?: () => void,
	) {
		super(plugin.app)
	}

	public update(): void {
		if (
			!this.progressBar ||
			!this.progressText ||
			!this.progressStats ||
			!this.currentFile ||
			!this.filesList
		) {
			return
		}

		let progress = this.plugin.progressService.syncProgress

		const percent =
			Math.round((progress.completed.length / progress.total) * 100) || 0

		this.progressBar.style.width = `${percent}%`
		this.progressText.setText(
			i18n.t('sync.percentComplete', {
				percent,
			}),
		)

		this.progressStats.setText(
			i18n.t('sync.progressStats', {
				completed: progress.completed.length,
				total: progress.total,
			}),
		)

		if (progress.completed.length > 0) {
			if (this.plugin.progressService.syncEnd) {
				this.currentFile.setText(i18n.t('sync.complete'))
			} else {
				const lastFile = progress.completed.at(-1)
				if (lastFile) {
					this.currentFile.setText(
						i18n.t('sync.currentFile', {
							path: lastFile.localPath,
						}),
					)
				}
			}
		}

		this.filesList.empty()

		const recentFiles = progress.completed.reverse()

		recentFiles.forEach((file) => {
			const item = this.filesList.createDiv({
				cls: 'flex items-center p-1 rounded text-3 gap-2 hover:bg-[var(--background-secondary)]',
			})

			const icon = item.createSpan({ cls: 'text-[var(--text-muted)]' })

			if (file instanceof PullTask) {
				setIcon(icon, 'arrow-down-narrow-wide')
			} else if (file instanceof PushTask) {
				setIcon(icon, 'arrow-up-narrow-wide')
			} else if (
				file instanceof MkdirLocalTask ||
				file instanceof MkdirRemoteTask
			) {
				setIcon(icon, 'folder-plus')
			} else if (
				file instanceof RemoveLocalTask ||
				file instanceof RemoveRemoteTask
			) {
				setIcon(icon, 'trash')
			} else if (file instanceof ConflictResolveTask) {
				setIcon(icon, 'git-merge')
			} else {
				setIcon(icon, 'file')
			}

			const typeLabel = item.createSpan({
				cls: 'flex-none w-15 text-[var(--text-normal)] font-500',
			})

			if (file instanceof PullTask) {
				typeLabel.setText(i18n.t('sync.fileOp.pull'))
			} else if (file instanceof PushTask) {
				typeLabel.setText(i18n.t('sync.fileOp.push'))
			} else if (
				file instanceof MkdirLocalTask ||
				file instanceof MkdirRemoteTask
			) {
				typeLabel.setText(i18n.t('sync.fileOp.mkdir'))
			} else if (
				file instanceof RemoveLocalTask ||
				file instanceof RemoveRemoteTask
			) {
				typeLabel.setText(i18n.t('sync.fileOp.remove'))
			} else if (file instanceof ConflictResolveTask) {
				typeLabel.setText(i18n.t('sync.fileOp.conflict'))
			} else {
				typeLabel.setText(i18n.t('sync.fileOp.sync'))
			}

			const filePath = item.createSpan({
				cls: 'flex-1 truncate overflow-hidden whitespace-nowrap',
			})
			filePath.setText(
				i18n.t('sync.filePath', {
					path: file.localPath,
				}),
			)
		})
	}

	onOpen() {
		const { contentEl } = this
		contentEl.empty()

		const container = contentEl.createDiv({
			cls: 'flex flex-col gap-4 h-50vh max-h-50vh',
		})

		const header = container.createDiv({
			cls: 'border-b border-[var(--background-modifier-border)]',
		})

		const title = header.createEl('h2', {
			cls: 'm-0',
		})
		title.setText(i18n.t('sync.progressTitle'))

		const statusSection = container.createDiv({
			cls: 'flex flex-col gap-1',
		})

		const currentOperation = statusSection.createDiv()
		currentOperation.setText(i18n.t('sync.syncingFiles'))

		const currentFile = statusSection.createDiv({
			cls: 'text-3 text-[var(--text-muted)] truncate overflow-hidden whitespace-nowrap',
		})

		const progressSection = container.createDiv({
			cls: 'flex flex-col gap-2',
		})

		const progressStats = progressSection.createDiv({
			cls: 'text-3.25',
		})

		const progressBarContainer = progressSection.createDiv({
			cls: 'relative h-5 bg-[var(--background-secondary)] rounded overflow-hidden',
		})

		const progressBar = progressBarContainer.createDiv({
			cls: 'absolute h-full bg-[var(--interactive-accent)] w-0 transition-width',
		})

		const progressText = progressBarContainer.createDiv({
			cls: 'absolute w-full text-center text-3 leading-5 text-[var(--text-on-accent)] mix-blend-difference',
		})
		const filesSection = container.createDiv({
			cls: 'flex flex-col flex-1 gap-2 mt-2 overflow-y-auto',
		})

		const filesHeader = filesSection.createDiv({
			cls: 'font-500 text-3.5 pb-1 border-b border-[var(--background-modifier-border)]',
		})
		filesHeader.setText(i18n.t('sync.completedFilesTitle'))

		const filesList = filesSection.createDiv({
			cls: 'flex-1 overflow-y-auto border border-[var(--background-modifier-border)] border-solid rounded p-1',
		})

		this.progressBar = progressBar
		this.progressText = progressText
		this.progressStats = progressStats
		this.currentFile = currentFile
		this.filesList = filesList

		this.update()
	}

	onClose(): void {
		const { contentEl } = this
		contentEl.empty()
		if (this.closeCallback) {
			this.closeCallback()
		}
	}
}
