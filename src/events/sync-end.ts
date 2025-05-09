import { Subject } from 'rxjs'

interface SyncEndProps {
	showNotice: boolean
	failedCount: number
}

const endSync = new Subject<SyncEndProps>()

export const onEndSync = () => endSync.asObservable()
export const emitEndSync = (props: SyncEndProps) => endSync.next(props)
