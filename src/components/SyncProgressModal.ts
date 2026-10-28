import { ButtonComponent, Modal, Notice, Platform, setIcon } from 'obsidian'
import { Subscription } from 'rxjs'
import CleanRecordTask from '~/sync/tasks/clean-record.task'
import FilenameErrorTask from '~/sync/tasks/filename-error.task'
import MkdirsRemoteTask from '~/sync/tasks/mkdirs-remote.task'
import RemoveRemoteRecursivelyTask from '~/sync/tasks/remove-remote-recursively.task'
import SkippedTask from '~/sync/tasks/skipped.task'
import { BaseTask } from '~/sync/tasks/task.interface'
import {
	addClassTokens,
	removeClassTokens,
	toggleClassTokens,
} from '~/utils/class-tokens'
import getTaskName from '~/utils/get-task-name'
import { getSyncPreparationText } from '~/utils/sync-preparation-text'
import NutstorePlugin from '..'
import {
	emitCancelSync,
	onSyncUpdateMtimeProgress,
	type SyncPreparationProgress,
} from '../events'
import i18n from '../i18n'
import ConflictResolveTask from '../sync/tasks/conflict-resolve.task'
import MkdirLocalTask from '../sync/tasks/mkdir-local.task'
import MkdirRemoteTask from '../sync/tasks/mkdir-remote.task'
import PullTask from '../sync/tasks/pull.task'
import PushTask from '../sync/tasks/push.task'
import RemoveLocalTask from '../sync/tasks/remove-local.task'
import RemoveRemoteTask from '../sync/tasks/remove-remote.task'

type SyncProgressModalState =
	| 'preparing'
	| 'syncing'
	| 'cancelling'
	| 'complete'
	| 'warning'
	| 'error'
	| 'cancelled'

export default class SyncProgressModal extends Modal {
	private progressTitle!: HTMLElement
	private statusIcon!: HTMLDivElement
	private statusSection!: HTMLDivElement
	private statusMessage!: HTMLDivElement
	private progressBar!: HTMLDivElement
	private progressText!: HTMLDivElement
	private progressLabel!: HTMLDivElement
	private progressTrack!: HTMLDivElement
	private progressHint!: HTMLDivElement
	private largeUploadHint!: HTMLDivElement
	private scanStats!: HTMLDivElement
	private scannedCount!: HTMLDivElement
	private queuedCount!: HTMLDivElement
	private discoveredCount!: HTMLDivElement
	private currentFile!: HTMLDivElement
	private filesList!: HTMLDivElement
	private filesSection!: HTMLDivElement
	private updateMtimeSubscription: Subscription
	private stopButtonComponent!: ButtonComponent
	private hideButtonComponent!: ButtonComponent

	private cacheProgressBar!: HTMLDivElement
	private cacheProgressText!: HTMLDivElement
	private cacheCurrentOperation!: HTMLDivElement
	private cacheProgressSection!: HTMLDivElement

	constructor(
		private plugin: NutstorePlugin,
		private closeCallback?: () => void,
	) {
		super(plugin.app)
		this.updateMtimeSubscription = onSyncUpdateMtimeProgress().subscribe(
			(progress) => {
				this.updateCacheProgress(progress.total, progress.completed)
			},
		)
	}

	public update(): void {
		if (
			!this.progressTitle ||
			!this.statusIcon ||
			!this.statusSection ||
			!this.statusMessage ||
			!this.progressBar ||
			!this.progressText ||
			!this.progressLabel ||
			!this.currentFile ||
			!this.filesList ||
			this.stopButtonComponent === undefined ||
			this.hideButtonComponent === undefined
		) {
			return
		}

		const progress = this.plugin.sync.progress.syncProgress
		const preparation = this.plugin.sync.progress.preparationProgress
		const failedCount = this.plugin.sync.progress.syncFailedCount
		const preparationText = preparation
			? getSyncPreparationText(preparation)
			: null
		const state: SyncProgressModalState = this.plugin.sync.progress.syncEnd
			? failedCount > 0
				? 'warning'
				: 'complete'
			: this.plugin.sync.progress.cancellationState === 'complete'
				? 'cancelled'
				: this.plugin.sync.progress.cancellationState === 'requested'
					? 'cancelling'
					: this.plugin.sync.progress.syncFailed
						? 'error'
						: preparation
							? 'preparing'
							: 'syncing'

		if (
			Platform.isMobile &&
			progress.hasLargeUploads &&
			this.plugin.settings.skipLargeFiles.maxSize.trim() === ''
		) {
			this.largeUploadHint.show()
		} else {
			this.largeUploadHint.hide()
		}

		this.updateHeader(state, preparationText?.operation, failedCount)
		this.updateControls(state)
		this.modalEl.dataset.state = state
		this.modalEl.dataset.preparationPhase = preparation?.traversal?.phase ?? ''
		const hasStatusDetails =
			state === 'preparing'
				? Boolean(
						preparation?.traversal?.currentPath ||
						(preparation?.traversal?.phase === 'incremental' &&
							preparationText?.detail),
					)
				: (state === 'syncing' || state === 'cancelling') &&
					progress.current !== null
		if (hasStatusDetails) {
			this.statusSection.show()
		} else {
			this.statusSection.hide()
		}

		if (state === 'preparing' && preparation && preparationText) {
			this.currentFile.setText(preparation.traversal?.currentPath ?? '')
			this.currentFile.title = preparation.traversal?.currentPath ?? ''
			if (
				preparationText.detail &&
				preparation.traversal?.phase === 'incremental'
			) {
				this.statusMessage.setText(preparationText.detail)
				this.statusMessage.show()
			} else {
				this.statusMessage.hide()
			}
			this.resetCacheProgress()
			this.updatePreparationProgress(preparation, preparationText.operation)
			this.filesSection.hide()
			return
		}

		this.progressBar.removeClass('nutstore-sync-progress-indeterminate')
		this.scanStats.hide()
		this.progressHint.hide()
		if (progress.total === 0) {
			this.filesSection.hide()
		} else {
			this.filesSection.show()
		}

		const percent =
			state === 'complete' && progress.total === 0
				? 100
				: Math.round((progress.completed.length / progress.total) * 100) || 0

		this.progressBar.setCssProps({ width: `${percent}%` })
		this.progressText.setText(
			i18n.t('sync.percentComplete', {
				percent,
			}),
		)

		this.progressLabel.setText(i18n.t('sync.progressLabel'))
		this.progressTrack.setAttribute('aria-label', i18n.t('sync.progressLabel'))
		this.progressTrack.setAttribute('aria-valuenow', String(percent))
		this.progressTrack.setAttribute(
			'aria-valuetext',
			this.progressText.textContent ?? '',
		)

		this.statusMessage.hide()
		if ((state === 'syncing' || state === 'cancelling') && progress.current) {
			this.currentFile.setText(
				i18n.t('sync.currentFile', {
					path: progress.current.localPath,
				}),
			)
			this.currentFile.title = progress.current.localPath
		} else {
			this.currentFile.setText('')
			this.currentFile.title = ''
		}

		this.filesList.empty()

		const isCurrentInFlight =
			progress.current !== null &&
			!progress.completed.some((c) => c.task === progress.current)
		if (isCurrentInFlight) {
			this.renderTaskRow(progress.current!, 'in-progress')
		}

		const recentFiles = progress.completed.slice().reverse()

		recentFiles.forEach(({ task, success }) => {
			this.renderTaskRow(task, success ? 'success' : 'failed')
		})
	}

	private updatePreparationProgress(
		preparation: SyncPreparationProgress,
		operation: string,
	): void {
		const traversal = preparation.traversal
		const isDirectoryScan =
			preparation.phase === 'traversingRemote' &&
			(traversal?.phase === 'scanning' ||
				(traversal?.phase === 'retrying' && traversal.queuedDirectories > 0))
		const label = isDirectoryScan
			? i18n.t('sync.preparation.progressLabel')
			: operation
		this.progressLabel.setText(label)
		this.progressTrack.setAttribute('aria-label', label)
		// New directories can be discovered at any time. This ratio describes
		// known work, not a percentage of the entire remote tree or sync.
		this.progressTrack.removeAttribute('aria-valuenow')
		let percent: number | null = null
		if (isDirectoryScan && traversal) {
			const knownDirectories =
				traversal.processedDirectories + traversal.queuedDirectories
			if (knownDirectories > 0) {
				percent = (traversal.processedDirectories / knownDirectories) * 100
			}
			this.scannedCount.setText(String(traversal.processedDirectories))
			this.queuedCount.setText(String(traversal.queuedDirectories))
			this.discoveredCount.setText(String(traversal.discoveredItems))
			this.scanStats.show()
			this.progressHint.setText(i18n.t('sync.preparation.knownDirectoriesHint'))
			this.progressHint.show()
			this.progressText.setText(
				`${traversal.processedDirectories} / ${knownDirectories}`,
			)
			this.progressTrack.setAttribute(
				'aria-valuetext',
				i18n.t('sync.preparation.traversalStats', {
					processed: traversal.processedDirectories,
					queued: traversal.queuedDirectories,
					items: traversal.discoveredItems,
				}),
			)
		} else {
			this.scanStats.hide()
			this.progressHint.hide()
			this.progressText.setText('')
			this.progressTrack.setAttribute('aria-valuetext', operation)
		}
		const indeterminate = percent === null
		this.progressBar.classList.toggle(
			'nutstore-sync-progress-indeterminate',
			indeterminate,
		)
		this.progressBar.setCssProps({
			width: indeterminate ? '40%' : `${percent}%`,
		})
	}

	private updateHeader(
		state: SyncProgressModalState,
		preparationOperation?: string,
		failedCount = 0,
	): void {
		const stateClasses = [
			'nutstore-sync-progress__status-icon--preparing',
			'nutstore-sync-progress__status-icon--syncing',
			'nutstore-sync-progress__status-icon--complete',
			'nutstore-sync-progress__status-icon--warning',
			'nutstore-sync-progress__status-icon--error',
			'nutstore-sync-progress__status-icon--cancelled',
		]
		removeClassTokens(this.statusIcon, ...stateClasses)
		addClassTokens(
			this.statusIcon,
			`nutstore-sync-progress__status-icon--${state === 'cancelling' ? 'syncing' : state}`,
		)

		const icon =
			state === 'preparing' || state === 'cancelling'
				? 'loader-circle'
				: state === 'syncing'
					? 'refresh-cw'
					: state === 'complete'
						? 'circle-check-big'
						: state === 'warning'
							? 'triangle-alert'
							: state === 'cancelled'
								? 'circle-stop'
								: 'circle-x'
		if (this.statusIcon.dataset.icon !== icon) {
			this.statusIcon.empty()
			setIcon(this.statusIcon, icon)
			this.statusIcon.dataset.icon = icon
		}
		this.statusIcon.classList.toggle(
			'nutstore-sync-spinning',
			state === 'preparing' || state === 'syncing' || state === 'cancelling',
		)

		const title =
			(state === 'preparing' ? preparationOperation : undefined) ||
			(state === 'syncing' || state === 'cancelling'
				? i18n.t('sync.syncingFiles')
				: state === 'complete'
					? i18n.t('sync.progressCompleteTitle')
					: state === 'warning'
						? i18n.t('sync.completeWithFailed', { failedCount })
						: state === 'cancelled'
							? i18n.t('sync.cancelled')
							: state === 'error'
								? i18n.t('sync.failedStatus')
								: i18n.t('sync.progressTitle'))
		this.progressTitle.setText(title)
	}

	private updateControls(state: SyncProgressModalState): void {
		const isTerminal =
			state === 'complete' ||
			state === 'warning' ||
			state === 'error' ||
			state === 'cancelled'

		toggleClassTokens(
			this.stopButtonComponent.buttonEl,
			':uno: hidden',
			isTerminal,
		)
		this.stopButtonComponent.setButtonText(
			i18n.t(state === 'cancelling' ? 'sync.cancelling' : 'sync.stopButton'),
		)
		this.hideButtonComponent.setButtonText(
			i18n.t(isTerminal ? 'sync.closeButton' : 'sync.hideButton'),
		)
	}

	private renderTaskRow(
		file: BaseTask,
		status: 'in-progress' | 'success' | 'failed',
	): void {
		const iconCls =
			status === 'in-progress'
				? ':uno: text-[var(--text-warning)]'
				: status === 'failed'
					? ':uno: text-[var(--text-error)]'
					: ':uno: text-[var(--text-muted)]'
		const labelCls =
			status === 'failed'
				? ':uno: text-[var(--text-error)]'
				: ':uno: text-[var(--text-normal)]'

		const item = this.filesList.createDiv({
			cls: ':uno: flex items-center p-1 rounded text-2.5 gap-2 hover:bg-[var(--background-secondary)]',
		})

		const icon = item.createSpan({ cls: iconCls })

		if (file instanceof CleanRecordTask) {
			setIcon(icon, 'archive-x')
		} else if (file instanceof ConflictResolveTask) {
			setIcon(icon, 'git-merge')
		} else if (file instanceof FilenameErrorTask) {
			setIcon(icon, 'refresh-cw-off')
		} else if (
			file instanceof MkdirLocalTask ||
			file instanceof MkdirRemoteTask ||
			file instanceof MkdirsRemoteTask
		) {
			setIcon(icon, 'folder-plus')
		} else if (file instanceof PullTask) {
			setIcon(icon, 'arrow-down-narrow-wide')
		} else if (file instanceof PushTask) {
			setIcon(icon, 'arrow-up-narrow-wide')
		} else if (
			file instanceof RemoveLocalTask ||
			file instanceof RemoveRemoteTask ||
			file instanceof RemoveRemoteRecursivelyTask
		) {
			setIcon(icon, 'trash')
		} else if (file instanceof SkippedTask) {
			setIcon(icon, 'chevron-last')
		} else {
			setIcon(icon, 'arrow-left-right')
		}

		const typeLabel = item.createSpan({
			cls: `:uno: flex-none w-17 md:w-24 font-500 ${labelCls}`,
		})
		typeLabel.setText(getTaskName(file))

		const filePath = item.createSpan({ cls: ':uno: flex-1 break-all' })
		filePath.setText(i18n.t('sync.filePath', { path: file.localPath }))
	}

	onOpen() {
		const { contentEl } = this
		contentEl.empty()
		this.modalEl.addClass('nutstore-sync-progress-modal')
		contentEl.addClass('nutstore-sync-progress-modal__content')

		const container = contentEl.createDiv({
			cls: 'nutstore-sync-progress',
		})

		const title = this.titleEl
		title.empty()
		title.addClass('nutstore-sync-progress__native-title')

		const heading = title.createDiv({
			cls: 'nutstore-sync-progress__heading',
		})
		const statusIcon = heading.createDiv({
			cls: 'nutstore-sync-progress__status-icon--preparing',
		})
		setIcon(statusIcon, 'loader-circle')
		const titleText = title.createSpan({
			cls: 'nutstore-sync-progress__title-text',
		})
		titleText.setText(i18n.t('sync.progressTitle'))

		const statusSection = container.createDiv({
			cls: 'nutstore-sync-progress__status',
		})

		const currentFile = statusSection.createDiv({
			cls: 'nutstore-sync-progress__current-file',
		})

		const statusMessage = statusSection.createDiv({
			cls: 'nutstore-sync-progress__summary',
		})
		statusMessage.hide()

		const progressCard = container.createDiv({
			cls: 'nutstore-sync-progress__card',
		})
		const progressSection = progressCard.createDiv({
			cls: 'nutstore-sync-progress__primary',
		})

		const progressMeta = progressSection.createDiv({
			cls: 'nutstore-sync-progress__meta',
		})
		const progressLabel = progressMeta.createDiv({
			cls: 'nutstore-sync-progress__label',
		})
		progressLabel.setText(i18n.t('sync.progressLabel'))
		const progressText = progressMeta.createDiv({
			cls: 'nutstore-sync-progress__bar-label',
		})

		const progressBarContainer = progressSection.createDiv({
			cls: 'nutstore-sync-progress__bar-container',
			attr: {
				role: 'progressbar',
				'aria-valuemin': '0',
				'aria-valuemax': '100',
			},
		})

		const progressBar = progressBarContainer.createDiv({
			cls: 'nutstore-sync-progress__bar',
		})

		this.progressTrack = progressBarContainer
		this.progressHint = progressSection.createDiv({
			cls: 'nutstore-sync-progress__hint',
		})
		this.largeUploadHint = progressSection.createDiv({
			cls: 'nutstore-sync-progress__hint nutstore-sync-progress__large-upload-hint',
			text: i18n.t('sync.mobileLargeUploadHint', {
				setting: i18n.t('settings.skipLargeFiles.name'),
			}),
		})
		this.largeUploadHint.hide()
		this.scanStats = progressSection.createDiv({
			cls: 'nutstore-sync-progress__stats',
		})
		const createScanStat = (label: string): HTMLDivElement => {
			const stat = this.scanStats.createDiv({
				cls: 'nutstore-sync-progress__stat',
			})
			const count = stat.createDiv({
				cls: 'nutstore-sync-progress__stat-count',
			})
			stat.createDiv({ cls: 'nutstore-sync-progress__stat-label', text: label })
			return count
		}
		this.scannedCount = createScanStat(
			i18n.t('sync.preparation.scannedDirectories'),
		)
		this.queuedCount = createScanStat(
			i18n.t('sync.preparation.queuedDirectories'),
		)
		this.discoveredCount = createScanStat(
			i18n.t('sync.preparation.discoveredItems'),
		)

		// Cache progress section
		const cacheProgressSection = progressCard.createDiv({
			cls: 'nutstore-sync-progress__cache',
		})
		this.cacheProgressSection = cacheProgressSection
		this.cacheProgressSection.hide()
		this.cacheCurrentOperation = cacheProgressSection.createDiv()
		this.cacheCurrentOperation.setText(i18n.t('sync.updatingCache'))
		this.cacheCurrentOperation.hide()

		const cacheProgressMeta = cacheProgressSection.createDiv({
			cls: 'nutstore-sync-progress__meta',
		})
		const cacheProgressLabel = cacheProgressMeta.createDiv({
			cls: 'nutstore-sync-progress__label',
		})
		cacheProgressLabel.setText(i18n.t('sync.cacheProgressLabel'))

		const cacheProgressBarContainer = cacheProgressSection.createDiv({
			cls: 'nutstore-sync-progress__bar-container',
		})
		cacheProgressBarContainer.hide()

		this.cacheProgressBar = cacheProgressBarContainer.createDiv({
			cls: 'nutstore-sync-progress__bar',
		})
		this.cacheProgressText = cacheProgressMeta.createDiv({
			cls: 'nutstore-sync-progress__bar-label',
		})

		const filesSection = container.createDiv({
			cls: 'nutstore-sync-progress__files',
		})

		const filesList = filesSection.createDiv({
			cls: 'nutstore-sync-progress__files-list',
		})

		this.progressTitle = titleText
		this.statusIcon = statusIcon
		this.statusSection = statusSection
		this.statusMessage = statusMessage
		this.progressBar = progressBar
		this.progressText = progressText
		this.progressLabel = progressLabel
		this.currentFile = currentFile
		this.filesList = filesList
		this.filesSection = filesSection

		const footerButtons = contentEl.createDiv({
			cls: 'nutstore-sync-progress__footer',
		})

		const stopButton = new ButtonComponent(footerButtons)
			.setButtonText(i18n.t('sync.stopButton'))
			.onClick(() => {
				if (this.plugin.sync.progress.cancellationState === 'requested') {
					new Notice(i18n.t('sync.cancellingHint'), 3000)
					return
				}
				emitCancelSync()
			})
		stopButton.buttonEl.addClass('mod-warning')
		this.stopButtonComponent = stopButton

		this.hideButtonComponent = new ButtonComponent(footerButtons)
			.setButtonText(i18n.t('sync.hideButton'))
			.onClick(() => this.close())

		this.update()
	}

	onClose(): void {
		this.updateMtimeSubscription.unsubscribe()
		const { contentEl } = this
		contentEl.empty()
		contentEl.removeClass('nutstore-sync-progress-modal__content')
		this.titleEl.empty()
		this.titleEl.removeClass('nutstore-sync-progress__native-title')
		this.modalEl.removeClass('nutstore-sync-progress-modal')
		if (this.closeCallback) {
			this.closeCallback()
		}
	}

	private updateCacheProgress(total: number, completed: number): void {
		if (
			!this.cacheProgressBar ||
			!this.cacheProgressText ||
			!this.cacheCurrentOperation
		) {
			return
		}

		this.cacheCurrentOperation.show()
		this.cacheProgressSection.show()
		this.cacheProgressBar.parentElement?.show()

		const percent = Math.round((completed / total) * 100) || 0

		this.cacheProgressBar.setCssProps({ width: `${percent}%` })
		this.cacheProgressText.setText(
			i18n.t('sync.percentComplete', {
				percent,
			}),
		)

		if (completed === total) {
			this.cacheCurrentOperation.hide()
		}
	}

	private resetCacheProgress(): void {
		if (
			!this.cacheProgressBar ||
			!this.cacheProgressText ||
			!this.cacheCurrentOperation
		) {
			return
		}

		this.cacheCurrentOperation.hide()
		this.cacheProgressSection.hide()
		this.cacheProgressBar.parentElement?.hide()
		this.cacheProgressBar.setCssProps({ width: '0%' })
		this.cacheProgressText.setText('')
	}
}
