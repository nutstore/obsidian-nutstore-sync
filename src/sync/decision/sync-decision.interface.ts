import { StatModel } from '~/model/stat.model'
import { SyncMode } from '~/settings'
import { ConflictStrategy } from '../tasks/conflict-resolve.task'
import { BaseTask } from '../tasks/task.interface'

export interface SyncDecisionSettings {
	skipLargeFiles: { maxSize: string }
	conflictStrategy: ConflictStrategy
	useGitStyle: boolean
	syncMode: SyncMode
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
}

export interface ConflictTaskOptions extends TaskOptions {
	record?: SyncRecordItem
	strategy: ConflictStrategy
	localStat: StatModel
	remoteStat: StatModel
	useGitStyle: boolean
}

export interface TaskFactory {
	createPullTask(options: TaskOptions): BaseTask
	createPushTask(options: TaskOptions): BaseTask
	createConflictResolveTask(options: ConflictTaskOptions): BaseTask
	createNoopTask(options: TaskOptions): BaseTask
	createRemoveLocalTask(options: TaskOptions): BaseTask
	createRemoveRemoteTask(options: TaskOptions): BaseTask
	createMkdirLocalTask(options: TaskOptions): BaseTask
	createMkdirRemoteTask(options: TaskOptions): BaseTask
	createCleanRecordTask(options: TaskOptions): BaseTask
	createFilenameErrorTask(options: TaskOptions): BaseTask
}

export interface SyncDecisionInput {
	settings: SyncDecisionSettings
	localStats: StatModel[]
	remoteStats: StatModel[]
	syncRecords: Map<string, SyncRecordItem>
	remoteBaseDir: string
	compareFileContent: (
		filePath: string,
		baseContent: ArrayBuffer,
	) => Promise<boolean>
	taskFactory: TaskFactory
}
