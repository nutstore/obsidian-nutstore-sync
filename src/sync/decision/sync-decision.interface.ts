import { FsWalkResult } from '~/fs/fs.interface'
import { StatModel } from '~/model/stat.model'
import type { SyncRecordModel } from '~/model/sync-record.model'
import { SyncMode } from '~/settings'
import type { SyncLogger } from '~/sync/log'
import { ConflictStrategy } from '../tasks/conflict-resolve.task'
import { SkippedTaskReasonOptions } from '../tasks/skipped.task'
import { BaseTask } from '../tasks/task.interface'

export interface SyncDecisionSettings {
	skipLargeFiles: { maxSize: string }
	mobileAppDownloadFileChunkSize: string
	conflictStrategy: ConflictStrategy
	syncMode: SyncMode
	configDir: string
}

export type SyncRecordItem = SyncRecordModel

export interface TaskOptions {
	remotePath: string
	localPath: string
	remoteBaseDir: string
	recursive?: boolean
}

export interface MoveRemoteTaskOptionsInput extends TaskOptions {
	fromLocalPath: string
	fromRemotePath: string
	/** Verified local snapshot matching the moved remote bytes during planning. */
	expectedLocalStat?: Extract<StatModel, { isDir: false }>
	/** Remote file snapshot whose ETag must still match after server-side MOVE. */
	expectedRemoteStat?: Extract<StatModel, { isDir: false }>
}

export interface ConflictTaskOptions extends TaskOptions {
	record?: SyncRecordItem
	strategy: ConflictStrategy
	localStat: StatModel
	remoteStat: StatModel
	mobileAppDownloadFileChunkSize?: string
}

export interface PullTaskOptions extends TaskOptions {
	remoteSize: number
	expectedRemoteStat?: Extract<StatModel, { isDir: false }>
	mobileAppDownloadFileChunkSize?: string
}

export interface PushTaskOptions extends TaskOptions {
	/** Present only when overwriting a known existing remote file (`If-Match`). */
	expectedRemoteEtag?: string | null
}

export interface NoopTaskOptions extends TaskOptions {
	localStat?: StatModel
	remoteStat?: StatModel
}

export type SkippedTaskOptions = TaskOptions & SkippedTaskReasonOptions

export interface TaskFactory {
	createPullTask(options: PullTaskOptions): BaseTask
	createPushTask(options: PushTaskOptions): BaseTask
	createMoveRemoteTask(options: MoveRemoteTaskOptionsInput): BaseTask
	createConflictResolveTask(options: ConflictTaskOptions): BaseTask
	createNoopTask(options: NoopTaskOptions): BaseTask
	createRemoveLocalTask(options: TaskOptions): BaseTask
	createRemoveRemoteTask(options: TaskOptions): BaseTask
	createMkdirLocalTask(options: TaskOptions): BaseTask
	createMkdirRemoteTask(options: TaskOptions): BaseTask
	createCleanRecordTask(options: TaskOptions): BaseTask
	createFilenameErrorTask(options: TaskOptions): BaseTask
	createSkippedTask(options: SkippedTaskOptions): BaseTask
}

export interface SyncDecisionInput {
	logger: SyncLogger
	settings: SyncDecisionSettings
	localStats: FsWalkResult[]
	remoteStats: FsWalkResult[]
	syncRecords: Map<string, SyncRecordItem>
	remoteBaseDir: string
	getBaseContent: (key: string) => Promise<ArrayBuffer | null>
	compareFileContent: (
		filePath: string,
		baseContent: ArrayBuffer,
	) => Promise<boolean>
	getLocalContentHash: (
		filePath: string,
		size: number,
	) => Promise<string | null>
	taskFactory: TaskFactory
}
