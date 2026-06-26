import { FsWalkResult } from '~/fs/fs.interface'
import { StatModel } from '~/model/stat.model'
import { SyncMode } from '~/settings'
import { ConflictStrategy } from '../tasks/conflict-resolve.task'
import { SkippedTaskReasonOptions } from '../tasks/skipped.task'
import { BaseTask } from '../tasks/task.interface'

export interface SyncDecisionSettings {
	skipLargeFiles: { maxSize: string }
	mobileAppDownloadFileChunkSize: string
	conflictStrategy: ConflictStrategy
	useGitStyle: boolean
	syncMode: SyncMode
	configDir: string
}

export interface SyncRecordItem {
	remote: StatModel
	local: StatModel
	base?: { key: string }
}

export interface TaskOptions {
	remotePath: string
	localPath: string
	remoteBaseDir: string
	recursive?: boolean
}

export interface ConflictTaskOptions extends TaskOptions {
	record?: SyncRecordItem
	strategy: ConflictStrategy
	localStat: StatModel
	remoteStat: StatModel
	useGitStyle: boolean
	mobileAppDownloadFileChunkSize?: string
}

export interface PullTaskOptions extends TaskOptions {
	remoteSize: number
	mobileAppDownloadFileChunkSize?: string
}

export type SkippedTaskOptions = TaskOptions & SkippedTaskReasonOptions

export interface TaskFactory {
	createPullTask(options: PullTaskOptions): BaseTask
	createPushTask(options: TaskOptions): BaseTask
	createConflictResolveTask(options: ConflictTaskOptions): BaseTask
	createNoopTask(options: TaskOptions): BaseTask
	createRemoveLocalTask(options: TaskOptions): BaseTask
	createRemoveRemoteTask(options: TaskOptions): BaseTask
	createMkdirLocalTask(options: TaskOptions): BaseTask
	createMkdirRemoteTask(options: TaskOptions): BaseTask
	createCleanRecordTask(options: TaskOptions): BaseTask
	createFilenameErrorTask(options: TaskOptions): BaseTask
	createSkippedTask(options: SkippedTaskOptions): BaseTask
}

export interface SyncDecisionInput {
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
	taskFactory: TaskFactory
}
