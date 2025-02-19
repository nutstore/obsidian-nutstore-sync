import { Subject } from 'rxjs'

const endSync = new Subject<number>()

export const onEndSync = () => endSync.asObservable()
export const emitEndSync = (failedCount: number = 0) =>
	endSync.next(failedCount)
