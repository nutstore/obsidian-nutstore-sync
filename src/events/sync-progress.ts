import { Subject } from 'rxjs'
import { BaseTask } from '~/sync/tasks/task.interface'

export interface CompletedTask {
	task: BaseTask
	success: boolean
}

export interface UpdateSyncProgress {
	total: number
	completed: CompletedTask[]
	current: BaseTask | null
	/** Supplied with the initial task list; retained for the current sync. */
	hasLargeUploads?: boolean
}

const syncProgress = new Subject<UpdateSyncProgress>()

export const onSyncProgress = () => syncProgress.asObservable()

export const emitSyncProgress = (
	total: number,
	completed: CompletedTask[],
	current: BaseTask | null,
	hasLargeUploads?: boolean,
) =>
	syncProgress.next({
		total,
		completed,
		current,
		hasLargeUploads,
	})
