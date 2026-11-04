import { Subject } from 'rxjs'
import { BaseTask } from '~/sync/tasks/task.interface'

export interface CompletedTask {
	task: BaseTask
	success: boolean
	/** Why the task failed; absent for successful tasks. */
	error?: string
}

/**
 * One step of task execution, stated as facts about displayable tasks only.
 * Each finished task is reported exactly once, so listeners append rather than
 * diff.
 */
export interface UpdateSyncProgress {
	total: number
	/** Tasks finished so far, including `finished`. */
	completedCount: number
	/** The task running now; `null` before the first task and between tasks. */
	running: BaseTask | null
	/** The task this update reports as finished. */
	finished?: CompletedTask
	/** Supplied with the initial task list; retained for the current sync. */
	hasLargeUploads?: boolean
}

const syncProgress = new Subject<UpdateSyncProgress>()

export const onSyncProgress = () => syncProgress.asObservable()

export const emitSyncProgress = (progress: UpdateSyncProgress) =>
	syncProgress.next(progress)
