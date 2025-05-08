import { Subject } from 'rxjs'

interface SyncStartProps {
	showNotice: boolean
}

const startSync = new Subject<SyncStartProps>()

export const onStartSync = () => startSync.asObservable()
export const emitStartSync = (props: SyncStartProps) => startSync.next(props)
