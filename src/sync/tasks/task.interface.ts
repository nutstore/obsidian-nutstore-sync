import type { Vault } from 'obsidian'
import { isAbsolute, join } from 'path-browserify'
import { WebDAVClient } from 'webdav'
import { SyncRecord } from '~/storage/sync-record'
import type { SyncLogger } from '~/sync/log'
import { MaybePromise } from '~/utils/types'
import { normalizeVaultPath } from '~/utils/normalize-vault-path'

export interface BaseTaskOptions {
	vault: Vault
	webdav: WebDAVClient
	remoteBaseDir: string
	remotePath: string
	localPath: string
	syncRecord: SyncRecord
	logger: SyncLogger
}

interface TaskSuccessResult {
	success: true
	skipRecord?: boolean
}

interface TaskFailureResult {
	success: false
	error: TaskError
	skipRecord?: boolean
}

export type TaskResult = TaskSuccessResult | TaskFailureResult

export abstract class BaseTask {
	constructor(readonly options: BaseTaskOptions) {}

	get vault() {
		return this.options.vault
	}

	get syncRecord() {
		return this.options.syncRecord
	}

	get webdav() {
		return this.options.webdav
	}

	get remoteBaseDir() {
		return this.options.remoteBaseDir
	}

	get remotePath() {
		return isAbsolute(this.options.remotePath)
			? this.options.remotePath
			: join(this.remoteBaseDir, this.options.remotePath)
	}

	get localPath() {
		return normalizeVaultPath(this.options.localPath)
	}

	get logger() {
		return this.options.logger
	}

	abstract exec(): MaybePromise<TaskResult>

	toJSON() {
		const { localPath, remoteBaseDir, remotePath } = this
		return {
			taskName: this.constructor.name,
			localPath,
			remoteBaseDir,
			remotePath,
		}
	}
}

export class TaskError extends Error {
	constructor(
		message: string,
		readonly task: BaseTask,
		readonly cause?: Error,
	) {
		super(message)
		this.name = 'TaskError'
	}
}

export function toTaskError(e: unknown, task: BaseTask): TaskError {
	if (e instanceof TaskError) {
		return e
	}
	const message = e instanceof Error ? e.message : String(e)
	return new TaskError(message, task, e instanceof Error ? e : undefined)
}
