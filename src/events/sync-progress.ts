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
}

const syncProgress = new Subject<UpdateSyncProgress>()

export const onSyncProgress = () => syncProgress.asObservable()

export const emitSyncProgress = (
	total: number,
	completed: CompletedTask[],
	current: BaseTask | null,
) =>
	syncProgress.next({
		total,
		completed,
		current,
	})
