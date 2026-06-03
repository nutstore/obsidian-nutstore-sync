import { isEqual } from 'ohash'
import { blobStore } from '~/storage/blob'
import { SyncRecord } from '~/storage/sync-record'
import { existsLocalPath, readLocalBinary } from '~/utils/local-vault-io'
import { MaybePromise } from '~/utils/types'
import { NutstoreSync } from '..'
import CleanRecordTask from '../tasks/clean-record.task'
import ConflictResolveTask from '../tasks/conflict-resolve.task'
import FilenameErrorTask from '../tasks/filename-error.task'
import MkdirLocalTask from '../tasks/mkdir-local.task'
import MkdirRemoteTask from '../tasks/mkdir-remote.task'
import NoopTask from '../tasks/noop.task'
import PullTask from '../tasks/pull.task'
import PushTask from '../tasks/push.task'
import RemoveLocalTask from '../tasks/remove-local.task'
import RemoveRemoteTask from '../tasks/remove-remote.task'
import SkippedTask from '../tasks/skipped.task'
import { BaseTask } from '../tasks/task.interface'
import {
	ConflictTaskOptions,
	PullTaskOptions,
	SkippedTaskOptions,
	SyncDecisionInput,
	TaskFactory,
	TaskOptions,
} from './sync-decision.interface'

export default abstract class BaseSyncDecider {
	constructor(
		protected sync: NutstoreSync,
		protected syncRecordStorage: SyncRecord,
	) {}

	abstract decide(): MaybePromise<BaseTask[]>

	protected getSyncRecordStorage() {
		return this.syncRecordStorage
	}

	protected async buildDecisionInput(): Promise<SyncDecisionInput> {
		const syncRecordStorage = this.getSyncRecordStorage()
		const [syncRecords, localStats, remoteStats] = await Promise.all([
			syncRecordStorage.getRecords(),
			this.sync.localFS.walk(),
			this.sync.remoteFs.walk(),
		])

		const commonTaskOptions = {
			webdav: this.webdav,
			vault: this.vault,
			remoteBaseDir: this.remoteBaseDir,
			syncRecord: syncRecordStorage,
		}

		const taskFactory: TaskFactory = {
			createPullTask: (options: PullTaskOptions) =>
				new PullTask({ ...commonTaskOptions, ...options }),
			createPushTask: (options: TaskOptions) =>
				new PushTask({ ...commonTaskOptions, ...options }),
			createConflictResolveTask: (options: ConflictTaskOptions) =>
				new ConflictResolveTask({ ...commonTaskOptions, ...options }),
			createNoopTask: (options: TaskOptions) =>
				new NoopTask({ ...commonTaskOptions, ...options }),
			createRemoveLocalTask: (options: TaskOptions) =>
				new RemoveLocalTask({ ...commonTaskOptions, ...options }),
			createRemoveRemoteTask: (options: TaskOptions) =>
				new RemoveRemoteTask({ ...commonTaskOptions, ...options }),
			createMkdirLocalTask: (options: TaskOptions) =>
				new MkdirLocalTask({ ...commonTaskOptions, ...options }),
			createMkdirRemoteTask: (options: TaskOptions) =>
				new MkdirRemoteTask({ ...commonTaskOptions, ...options }),
			createCleanRecordTask: (options: TaskOptions) =>
				new CleanRecordTask({ ...commonTaskOptions, ...options }),
			createFilenameErrorTask: (options: TaskOptions) =>
				new FilenameErrorTask({ ...commonTaskOptions, ...options }),
			createSkippedTask: (options: SkippedTaskOptions) =>
				new SkippedTask({ ...commonTaskOptions, ...options }),
		}

		const compareFileContent = async (
			filePath: string,
			baseContent: ArrayBuffer,
		): Promise<boolean> => {
			const exists = await existsLocalPath(this.vault, filePath)
			if (!exists) return false
			const currentContent = await readLocalBinary(this.vault, filePath)
			return isEqual(baseContent, currentContent)
		}

		const getBaseContent = async (key: string): Promise<ArrayBuffer | null> => {
			const blob = await blobStore.get(key)
			if (!blob) return null
			return await blob.arrayBuffer()
		}

		return {
			settings: {
				skipLargeFiles: this.settings.skipLargeFiles,
				mobileAppDownloadFileChunkSize:
					this.settings.mobileAppDownloadFileChunkSize,
				conflictStrategy: this.settings.conflictStrategy,
				useGitStyle: this.settings.useGitStyle,
				syncMode: this.settings.syncMode,
				configDir: this.vault.configDir,
			},
			localStats,
			remoteStats,
			syncRecords,
			remoteBaseDir: this.remoteBaseDir,
			getBaseContent,
			compareFileContent,
			taskFactory,
		}
	}

	get webdav() {
		return this.sync.webdav
	}

	get settings() {
		return this.sync.settings
	}

	get vault() {
		return this.sync.vault
	}

	get remoteBaseDir() {
		return this.sync.remoteBaseDir
	}
}
