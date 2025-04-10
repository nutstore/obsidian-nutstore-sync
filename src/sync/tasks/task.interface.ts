import { normalizePath, Vault } from 'obsidian'
import { isAbsolute, join } from 'path'
import { WebDAVClient } from 'webdav'
import { SyncRecord } from '~/storage/helper'

export interface BaseTaskOptions {
	vault: Vault
	webdav: WebDAVClient
	remoteBaseDir: string
	remotePath: string
	localPath: string
}

export interface TaskResult {
	success: boolean
	error?: TaskError
}

export abstract class BaseTask {
	constructor(readonly options: BaseTaskOptions) {}

	get vault() {
		return this.options.vault
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
		return normalizePath(this.options.localPath)
	}

	get syncRecord() {
		return new SyncRecord(this.vault, this.options.remoteBaseDir)
	}

	abstract exec(): Promise<TaskResult>
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
