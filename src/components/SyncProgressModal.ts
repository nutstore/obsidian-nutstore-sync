import createId from '~/utils/create-id'
import { ButtonComponent, Modal, Notice, Platform, setIcon } from 'obsidian'
import { Subscription } from 'rxjs'
import {
	addClassTokens,
	removeClassTokens,
	toggleClassTokens,
} from '~/utils/class-tokens'
import { describeSyncError } from '~/utils/describe-sync-error'
import { getTaskLabel, type TaskKind } from '~/utils/get-task-name'
import { getSyncPreparationText } from '~/utils/sync-preparation-text'
import NutstorePlugin from '..'
import {
	emitCancelSync,
	onSyncUpdateMtimeProgress,
	type SyncPreparationProgress,
} from '../events'
import i18n from '../i18n'
import {
	isSyncRunActive,
	type SyncRunSnapshot,
	type SyncRunStatus,
	type SyncTaskRecord,
	type SyncTaskRef,
} from '../services/progress.service'

const TASK_ICONS: Record<TaskKind, string> = {
	cleanRecord: 'archive-x',
	merge: 'git-merge',
	filenameError: 'refresh-cw-off',
	createLocalDir: 'folder-plus',
	createRemoteDir: 'folder-plus',
	createRemoteDirs: 'folder-plus',
	download: 'arrow-down-narrow-wide',
	upload: 'arrow-up-narrow-wide',
	removeLocal: 'trash',
	removeRemote: 'trash',
	removeRemoteRecursively: 'trash',
	skip: 'chevron-last',
	noop: 'arrow-left-right',
	sync: 'arrow-left-right',
}

const STATUS_TONES = [
	'preparing',
	'syncing',
	'complete',
	'warning',
	'error',
	'cancelled',
] as const

/** How each run status presents; exhaustive, so a new status must pick a look. */
const STATUS_VIEWS: Record<
	SyncRunStatus,
	{
		tone: (typeof STATUS_TONES)[number]
		icon: string
		title: (run: SyncRunSnapshot) => string
	}
> = {
	preparing: {
		tone: 'preparing',
		icon: 'loader-circle',
		title: () => i18n.t('sync.progressTitle'),
	},
	syncing: {
		tone: 'syncing',
		icon: 'refresh-cw',
		title: () => i18n.t('sync.syncingFiles'),
	},
	cancelling: {
		tone: 'syncing',
		icon: 'loader-circle',
		title: () => i18n.t('sync.syncingFiles'),
	},
	complete: {
		tone: 'complete',
		icon: 'circle-check-big',
		title: () => i18n.t('sync.progressCompleteTitle'),
	},
	partialScan: {
		tone: 'warning',
		icon: 'triangle-alert',
		title: () => i18n.t('sync.partialScanTitle'),
	},
	failedTasks: {
		tone: 'warning',
		icon: 'triangle-alert',
		title: ({ failedCount }) =>
			i18n.t('sync.completeWithFailed', { failedCount }),
	},
	error: {
		tone: 'error',
		icon: 'circle-x',
		title: () => i18n.t('sync.failedStatus'),
	},
	cancelled: {
		tone: 'cancelled',
		icon: 'circle-stop',
		title: () => i18n.t('sync.cancelled'),
	},
}

export default class SyncProgressModal extends Modal {
	private progressTitle!: HTMLElement
	private statusIcon!: HTMLDivElement
	private statusSection!: HTMLDivElement
	private statusMessage!: HTMLDivElement
	private scanIssuesSummary!: HTMLDivElement
	private scanIssuesText!: HTMLSpanElement
	private scanIssuesButton!: ButtonComponent
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
	/** What `filesList` currently shows, so updates only add what is new. */
	private renderedRecords?: readonly SyncTaskRecord[]
	private renderedCount = 0
	private inFlightRow: HTMLElement | null = null
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

		// The modal is only opened once a run exists; a late tick after the
		// service dropped it has nothing left to show.
		const run = this.plugin.sync.progress.run
		if (!run) return
		const { preparation, status: state } = run
		const preparationText = preparation
			? getSyncPreparationText(preparation)
			: null

		if (
			Platform.isMobile &&
			run.hasLargeUploads &&
			this.plugin.settings.skipLargeFiles.maxSize.trim() === ''
		) {
			this.largeUploadHint.show()
		} else {
			this.largeUploadHint.hide()
		}

		// Only a finished run carries scan issues; a new run starts with none.
		const scanIssueCount = run.scanIssues.length
		this.scanIssuesSummary.toggle(scanIssueCount > 0)
		if (scanIssueCount > 0) {
			this.scanIssuesText.setText(
				i18n.t('scanIssues.summary', { count: scanIssueCount }),
			)
			// Per update, so a language change while the view is open applies here too.
			this.scanIssuesButton.setButtonText(i18n.t('scanIssues.view'))
		}

		this.updateHeader(run, preparationText?.operation)
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
				: ((state === 'syncing' || state === 'cancelling') &&
						run.current !== null) ||
					(state === 'error' && run.error !== undefined)
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
		if (run.total === 0) {
			this.filesSection.hide()
		} else {
			this.filesSection.show()
		}

		const percent =
			state === 'complete' && run.total === 0
				? 100
				: Math.round((run.completed.length / run.total) * 100) || 0

		this.progressBar.setCssProps({ width: `${percent}%` })
		this.progressText.setText(
			i18n.t('sync.percentComplete', {
				percent,
			}),
		)

		this.progressLabel.setText(i18n.t('sync.progressLabel'))
		this.progressTrack.setAttribute('aria-valuenow', String(percent))
		this.progressTrack.setAttribute(
			'aria-valuetext',
			this.progressText.textContent ?? '',
		)

		if (state === 'error' && run.error) {
			this.statusMessage.setText(describeSyncError(run.error))
			this.statusMessage.show()
		} else {
			this.statusMessage.hide()
		}

		if ((state === 'syncing' || state === 'cancelling') && run.current) {
			this.currentFile.setText(
				i18n.t('sync.currentFile', {
					path: run.current.localPath,
				}),
			)
			this.currentFile.title = run.current.localPath
		} else {
			this.currentFile.setText('')
			this.currentFile.title = ''
		}

		this.renderFiles(run)
	}

	/**
	 * Newest first. Records only grow within a run, so each tick adds just the
	 * new rows; a different records array means a new run and a fresh list.
	 */
	private renderFiles({
		completed,
		current,
		currentInFlight,
	}: SyncRunSnapshot) {
		if (completed !== this.renderedRecords) {
			this.filesList.empty()
			this.renderedRecords = completed
			this.renderedCount = 0
			this.inFlightRow = null
		}
		this.inFlightRow?.remove()
		this.inFlightRow = null
		for (; this.renderedCount < completed.length; this.renderedCount++) {
			const record = completed[this.renderedCount]
			this.renderTaskRow(record, record.success ? 'success' : 'failed')
		}
		// An ended run has no task in flight, even if one was the last to start.
		if (current && currentInFlight) {
			this.inFlightRow = this.renderTaskRow(current, 'in-progress')
		}
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

	private updateHeader(run: SyncRunSnapshot, preparationOperation?: string) {
		const view = STATUS_VIEWS[run.status]
		removeClassTokens(
			this.statusIcon,
			...STATUS_TONES.map(
				(tone) => `nutstore-sync-progress__status-icon--${tone}`,
			),
		)
		addClassTokens(
			this.statusIcon,
			`nutstore-sync-progress__status-icon--${view.tone}`,
		)
		if (this.statusIcon.dataset.icon !== view.icon) {
			this.statusIcon.empty()
			setIcon(this.statusIcon, view.icon)
			this.statusIcon.dataset.icon = view.icon
		}
		this.statusIcon.classList.toggle(
			'nutstore-sync-spinning',
			isSyncRunActive(run.status),
		)
		this.progressTitle.setText(
			(run.status === 'preparing' ? preparationOperation : undefined) ||
				view.title(run),
		)
	}

	private updateControls(state: SyncRunStatus): void {
		const isTerminal = !isSyncRunActive(state)

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
		file: SyncTaskRef | SyncTaskRecord,
		status: 'in-progress' | 'success' | 'failed',
	): HTMLElement {
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
		setIcon(icon, TASK_ICONS[file.kind])

		const typeLabel = item.createSpan({
			cls: `:uno: flex-none w-17 md:w-24 font-500 ${labelCls}`,
		})
		typeLabel.setText(getTaskLabel(file))

		const detail = item.createDiv({ cls: ':uno: flex-1 min-w-0' })
		detail
			.createDiv({ cls: ':uno: break-all' })
			.setText(i18n.t('sync.filePath', { path: file.localPath }))
		const error = 'error' in file ? file.error : undefined
		if (status === 'failed' && error) {
			detail
				.createDiv({
					cls: ':uno: break-all text-[var(--text-muted)]',
				})
				.setText(error)
		}
		this.filesList.prepend(item)
		return item
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

		// The warning title stays short for narrow screens; this explanation owns
		// the count and the consequence for both devices.
		const scanIssuesSummary = container.createDiv({
			cls: 'nutstore-sync-progress__scan-issues',
		})
		scanIssuesSummary.hide()
		this.scanIssuesText = scanIssuesSummary.createSpan()
		// The list is opened on demand while this modal is up, so it never stacks
		// on top of the progress the user is watching.
		this.scanIssuesButton = new ButtonComponent(scanIssuesSummary).onClick(() =>
			this.plugin.sync.progress.showScanIssues(),
		)

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
		progressLabel.id = createId('accessible-label')
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

		progressBarContainer.setAttribute('aria-labelledby', progressLabel.id)
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
		this.scanIssuesSummary = scanIssuesSummary
		this.progressBar = progressBar
		this.progressText = progressText
		this.progressLabel = progressLabel
		this.currentFile = currentFile
		this.filesList = filesList
		this.renderedRecords = undefined
		this.filesSection = filesSection

		const footerButtons = contentEl.createDiv({
			cls: 'nutstore-sync-progress__footer',
		})

		const stopButton = new ButtonComponent(footerButtons)
			.setButtonText(i18n.t('sync.stopButton'))
			.onClick(() => {
				if (this.plugin.sync.progress.run?.status === 'cancelling') {
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
