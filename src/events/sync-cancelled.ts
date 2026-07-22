import { Subject } from 'rxjs'

const syncCancelled = new Subject<void>()

export const onSyncCancelled = () => syncCancelled.asObservable()
export const emitSyncCancelled = () => syncCancelled.next()
