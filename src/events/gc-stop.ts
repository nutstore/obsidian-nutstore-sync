import { Subject } from 'rxjs'

const stopGc = new Subject<void>()

export const onStopGc = () => stopGc.asObservable()
export const emitStopGc = () => stopGc.next()
