import { Subject } from 'rxjs'
import { BaseTask } from '~/sync/tasks/task.interface'

export interface UpdateSyncProgress {
	total: number
	completed: BaseTask[]
}

const syncProgress = new Subject<UpdateSyncProgress>()

export const onSyncProgress = () => syncProgress.asObservable()

export const emitSyncProgress = (total: number, completed: BaseTask[]) =>
	syncProgress.next({
		total,
		completed,
	})
