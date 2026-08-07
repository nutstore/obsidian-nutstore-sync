import { Subject } from 'rxjs'
import type { WebDAVTraversalProgress } from '~/utils/traverse-webdav'

export type SyncPreparationPhase =
	| 'checkingRemote'
	| 'loadingState'
	| 'traversingRemote'
	| 'analyzing'
	| 'savingCache'

export interface SyncPreparationProgress {
	phase: SyncPreparationPhase
	traversal?: WebDAVTraversalProgress
}

const syncPreparationProgress = new Subject<SyncPreparationProgress>()

export const onSyncPreparationProgress = () =>
	syncPreparationProgress.asObservable()

export const emitSyncPreparationProgress = (
	progress: SyncPreparationProgress,
) => syncPreparationProgress.next(progress)
