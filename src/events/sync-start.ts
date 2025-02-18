import { Subject } from 'rxjs'

const startSync = new Subject<void>()

export const onStartSync = () => startSync.asObservable()
export const emitStartSync = () => startSync.next()
