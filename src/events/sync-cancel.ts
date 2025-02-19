import { Subject } from 'rxjs'

const cancelSync = new Subject<void>()

export const onCancelSync = () => cancelSync.asObservable()
export const emitCancelSync = () => cancelSync.next()
