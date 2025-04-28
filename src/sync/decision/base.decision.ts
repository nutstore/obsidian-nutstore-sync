import { MaybePromise } from '~/utils/types'
import { NutstoreSync } from '..'
import { BaseTask } from '../tasks/task.interface'

export default abstract class BaseSyncDecision {
	constructor(protected sync: NutstoreSync) {}

	abstract decide(): MaybePromise<BaseTask[]>

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
