import { Subject } from 'rxjs'

export interface UpdateSyncUpdateMtimeProgress {
	total: number
	completed: number
}

const syncUpdateMtimeProgress = new Subject<UpdateSyncUpdateMtimeProgress>()

export const onSyncUpdateMtimeProgress = () =>
	syncUpdateMtimeProgress.asObservable()

export const emitSyncUpdateMtimeProgress = (total: number, completed: number) =>
	syncUpdateMtimeProgress.next({
		total,
		completed,
	})
