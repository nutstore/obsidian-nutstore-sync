import { Subject } from 'rxjs'
import { SyncProgress } from './types'

const syncProgress = new Subject<SyncProgress>()

export const onSyncProgress = () => syncProgress.asObservable()
export const emitSyncProgress = (total: number, completed: number) =>
	syncProgress.next({ total, completed })
