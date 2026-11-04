import type { ScanIssue } from '~/sync/scope'
import { throttle } from 'es-toolkit/compat'
import { Notice } from 'obsidian'
import FailedTasksModal from '../components/FailedTasksModal'
import ScanIssuesModal from '../components/ScanIssuesModal'
import SyncProgressModal from '../components/SyncProgressModal'
import {
	onEndSync,
	onCancelSync,
	onPreparingSync,
	onStartSync,
	onSyncCancelled,
	onSyncError,
	onSyncPreparationProgress,
	onSyncProgress,
	type SyncPreparationProgress,
} from '../events'
import i18n from '../i18n'
import NutstorePlugin from '../index'
import { describeTask, type TaskDescriptor } from '../utils/get-task-name'
import { BaseService } from './service.interface'
import type { BaseTask } from '~/sync/tasks/task.interface'

/**
 * Where a sync run is, or how it ended. The only place that decides this, so
 * the progress modal, and anything else that reports on a run, read one answer.
 */
export type SyncRunStatus =
	| 'preparing'
	| 'syncing'
	| 'cancelling'
	| 'complete'
	/** Some in-scope paths could not be read, so they were left untouched. */
	| 'partialScan'
	/** Everything was scanned, but some tasks failed. */
	| 'failedTasks'
	| 'error'
	| 'cancelled'

export const isSyncRunActive = (status: SyncRunStatus) =>
	status === 'preparing' || status === 'syncing' || status === 'cancelling'

/** A task as the user saw it, without the machinery needed to run it. */
export interface SyncTaskRef extends TaskDescriptor {
	localPath: string
}

export interface SyncTaskRecord extends SyncTaskRef {
	success: boolean
	/** Why the task failed; absent for successful tasks. */
	error?: string
}

/**
 * One sync run from its first preparation step to its outcome. It stays in
 * memory after the run ends, so the progress view can be reopened to see how
 * the last run went. The next run replaces it.
 */
export interface SyncRunSnapshot {
	status: SyncRunStatus
	startedAt: number
	/** Set once the run reaches a terminal status. */
	endedAt?: number
	preparation: SyncPreparationProgress | null
	total: number
	completed: readonly SyncTaskRecord[]
	/** The task most recently started; kept between tasks so the header holds still. */
	current: SyncTaskRef | null
	currentInFlight: boolean
	hasLargeUploads?: boolean
	failedCount: number
	scanIssues: readonly ScanIssue[]
	/** The failure that stopped the run, when its status is `error`. */
	error?: Error
}

const toRef = (task: BaseTask): SyncTaskRef => ({
	...describeTask(task),
	localPath: task.localPath,
})

export class ProgressService extends BaseService {
	private progressModal: SyncProgressModal | null = null
	private scanIssuesModal: ScanIssuesModal | null = null
	private failedTasksModal: FailedTasksModal | null = null

	/** `null` until the first run of this session starts. */
	public run: SyncRunSnapshot | null = null
	/** Backs `run.completed`; appended in place so large runs stay linear. */
	private records: SyncTaskRecord[] = []

	private subscriptions: { unsubscribe: () => void }[] = []

	constructor(private plugin: NutstorePlugin) {
		super()
	}

	override onload() {
		this.onunload()
		this.subscriptions = [
			onCancelSync().subscribe(() => {
				const status = this.run?.status
				if (
					!this.plugin.sync.executor.isRunning() ||
					(status !== 'preparing' && status !== 'syncing')
				)
					return
				this.patch({ status: 'cancelling' })
			}),
			onPreparingSync().subscribe(({ showNotice }) => {
				this.records = []
				this.run = {
					status: 'preparing',
					startedAt: Date.now(),
					preparation: { phase: 'checkingRemote' },
					total: 0,
					completed: this.records,
					current: null,
					currentInFlight: false,
					failedCount: 0,
					scanIssues: [],
				}
				if (showNotice) this.showProgressModal()
				else this.updateModal()
			}),
			onSyncPreparationProgress().subscribe((preparation) => {
				if (this.run && isSyncRunActive(this.run.status)) {
					this.patch({ preparation })
				}
			}),
			onStartSync().subscribe(() => {
				if (!this.run || !isSyncRunActive(this.run.status)) return
				this.patch({
					preparation: null,
					status: this.run.status === 'cancelling' ? 'cancelling' : 'syncing',
				})
			}),
			onEndSync().subscribe(({ failedCount, showNotice, scanIssues = [] }) => {
				const ended = this.finish({
					// An unread subtree outranks failed tasks: it may hide more work.
					status:
						scanIssues.length > 0
							? 'partialScan'
							: failedCount > 0
								? 'failedTasks'
								: 'complete',
					failedCount,
					scanIssues,
				})
				if (ended) this.presentOutcome(showNotice)
			}),
			onSyncError().subscribe((error) => {
				this.finish({ status: 'error', error })
			}),
			onSyncCancelled().subscribe(() => {
				this.finish({ status: 'cancelled' })
			}),
			onSyncProgress().subscribe((p) => {
				const run = this.run
				if (!run || !isSyncRunActive(run.status)) return
				if (p.finished) {
					const { task, success, error } = p.finished
					this.records.push({ ...toRef(task), success, error })
				}
				this.patch({
					total: p.total,
					completed: this.records,
					current: p.running ? toRef(p.running) : run.current,
					currentInFlight: p.running !== null,
					hasLargeUploads: p.hasLargeUploads ?? run.hasLargeUploads,
				})
			}),
		]
	}

	/**
	 * Closes the run in progress. Every run opens with a preparing event, so an
	 * outcome with no active run is a duplicate or a failure before any run began;
	 * neither replaces the last real run.
	 */
	private finish(
		outcome: Pick<SyncRunSnapshot, 'status'> & Partial<SyncRunSnapshot>,
	): boolean {
		if (!this.run || !isSyncRunActive(this.run.status)) return false
		this.patch({
			...outcome,
			preparation: null,
			currentInFlight: false,
			endedAt: Date.now(),
		})
		return true
	}

	/**
	 * The one rule for interrupting the user once a run ends. An open progress
	 * view already shows the outcome. Otherwise unread paths always surface,
	 * since they mean both devices were left untouched there; anything else is
	 * reported only for runs the user started.
	 */
	private presentOutcome(showNotice: boolean) {
		if (this.progressModal || !this.run) return
		if (this.run.status === 'partialScan') this.showScanIssues()
		else if (!showNotice) return
		else if (this.run.status === 'failedTasks') this.showFailedTasks()
		else new Notice(i18n.t('sync.complete'))
	}

	/** One list at a time: a later run refreshes the open list instead of stacking. */
	public showScanIssues() {
		const issues = this.run?.scanIssues ?? []
		if (this.scanIssuesModal?.modalEl.isConnected) {
			this.scanIssuesModal.update(issues)
			return
		}
		this.scanIssuesModal = new ScanIssuesModal(this.plugin.app, issues)
		this.scanIssuesModal.open()
	}

	private showFailedTasks() {
		this.failedTasksModal?.close()
		this.failedTasksModal = new FailedTasksModal(
			this.plugin.app,
			this.run?.completed.filter((record) => !record.success) ?? [],
		)
		this.failedTasksModal.open()
	}

	private patch(changes: Partial<SyncRunSnapshot>) {
		if (!this.run) return
		this.run = { ...this.run, ...changes }
		this.updateModal()
	}

	updateModal = throttle(() => {
		if (this.progressModal) {
			this.progressModal.update()
		}
	}, 200)

	/** Opens the live progress, or the outcome of the latest run once it ended. */
	public showProgressModal() {
		if (!this.plugin.sync.lifecycle.active) return
		if (!this.run) {
			new Notice(i18n.t('sync.noRunYet'))
			return
		}
		if (this.progressModal) {
			this.updateModal()
			return
		}
		this.progressModal = new SyncProgressModal(this.plugin, () => {
			this.progressModal = null
		})
		this.progressModal.open()
	}

	public hasVisibleSyncModal(): boolean {
		return this.progressModal !== null
	}

	public closeProgressModal() {
		if (this.progressModal) {
			this.progressModal.close()
			this.progressModal = null
		}
	}

	override onunload() {
		this.subscriptions.forEach((sub) => sub.unsubscribe())
		this.subscriptions = []
		this.closeProgressModal()
		this.scanIssuesModal?.close()
		this.scanIssuesModal = null
		this.failedTasksModal?.close()
		this.failedTasksModal = null
		this.updateModal.cancel()
	}
}
