import { Subject } from 'rxjs'

interface SyncPreparingProps {
	showNotice: boolean
}

const preparingSync = new Subject<SyncPreparingProps>()

export const onPreparingSync = () => preparingSync.asObservable()
export const emitPreparingSync = (props: SyncPreparingProps) =>
	preparingSync.next(props)
