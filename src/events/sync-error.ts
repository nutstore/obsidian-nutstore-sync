import { Subject } from 'rxjs'

const syncError = new Subject<Error>()

export const onSyncError = () => syncError.asObservable()
export const emitSyncError = (error: Error) => syncError.next(error)
