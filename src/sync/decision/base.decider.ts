import { SyncRecord } from '~/storage/sync-record'
import { MaybePromise } from '~/utils/types'
import { NutstoreSync } from '..'
import { BaseTask } from '../tasks/task.interface'

export default abstract class BaseSyncDecider {
	constructor(
		protected sync: NutstoreSync,
		protected syncRecordStorage: SyncRecord,
	) {}

	abstract decide(): MaybePromise<BaseTask[]>

	protected getSyncRecordStorage() {
		return this.syncRecordStorage
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
