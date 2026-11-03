import type { ScanIssue } from '~/sync/scope'
import { throttle } from 'es-toolkit/compat'
import { Notice } from 'obsidian'
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
	| 'warning'
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
	/** The task most recently started; kept after it completes to avoid flicker. */
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
				this.run = {
					...this.newRun(Date.now()),
					preparation: { phase: 'checkingRemote' },
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
			onEndSync().subscribe(({ failedCount, scanIssues = [] }) => {
				this.finish({
					status:
						failedCount > 0 || scanIssues.length > 0 ? 'warning' : 'complete',
					failedCount,
					scanIssues,
				})
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
				// `p.completed` only grows within a run; project just the new entries.
				if (p.completed.length < this.records.length) this.records = []
				for (const { task, success, error } of p.completed.slice(
					this.records.length,
				)) {
					this.records.push({ ...toRef(task), success, error })
				}
				this.patch({
					total: p.total,
					completed: this.records,
					current: p.current ? toRef(p.current) : null,
					currentInFlight:
						p.current !== null &&
						p.completed[p.completed.length - 1]?.task !== p.current,
					hasLargeUploads: p.hasLargeUploads ?? run.hasLargeUploads,
				})
			}),
		]
	}

	/**
	 * Silent runs may end without a preparing event (nothing to do, or an early
	 * failure). That still is the latest run, so it replaces the previous one.
	 */
	private finish(
		outcome: Pick<SyncRunSnapshot, 'status'> & Partial<SyncRunSnapshot>,
	) {
		const now = Date.now()
		const previous =
			this.run && isSyncRunActive(this.run.status) ? this.run : null
		this.run = {
			...(previous ?? this.newRun(now)),
			...outcome,
			preparation: null,
			currentInFlight: false,
			endedAt: now,
		}
		this.updateModal()
	}

	/** A run with nothing done yet; resets the records that back `completed`. */
	private newRun(startedAt: number): SyncRunSnapshot {
		this.records = []
		return {
			status: 'preparing',
			startedAt,
			preparation: null,
			total: 0,
			completed: this.records,
			current: null,
			currentInFlight: false,
			failedCount: 0,
			scanIssues: [],
		}
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
		this.updateModal.cancel()
	}
}
