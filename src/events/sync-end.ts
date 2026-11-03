import type { ScanIssue } from '~/sync/scope'
import { Subject } from 'rxjs'

interface SyncEndProps {
	showNotice: boolean
	failedCount: number
	scanIssues?: readonly ScanIssue[]
}

const endSync = new Subject<SyncEndProps>()

export const onEndSync = () => endSync.asObservable()
export const emitEndSync = (props: SyncEndProps) => endSync.next(props)
