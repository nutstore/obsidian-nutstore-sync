import { Subject } from 'rxjs'

export interface GcProgressEvent {
	current: number
	total: number
}

const gcProgress = new Subject<GcProgressEvent>()

export const onGcProgress = () => gcProgress.asObservable()

export const emitGcProgress = (current: number, total: number) =>
	gcProgress.next({ current, total })
