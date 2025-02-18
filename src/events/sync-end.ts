import { Subject } from 'rxjs'

const endSync = new Subject<void>()

export const onEndSync = () => endSync.asObservable()
export const emitEndSync = () => endSync.next()
