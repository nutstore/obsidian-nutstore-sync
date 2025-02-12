import { normalizePath, Vault } from 'obsidian'
import path from 'path'
import { WebDAVClient } from 'webdav'
import { SyncRecord } from '~/storage/helper'

export interface BaseTaskOptions {
	vault: Vault
	webdav: WebDAVClient
	remoteBaseDir: string
	remotePath: string
	localPath: string
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
		return path.isAbsolute(this.options.remotePath)
			? this.options.remotePath
			: path.resolve(this.remoteBaseDir, this.options.remotePath)
	}

	get localPath() {
		return normalizePath(this.options.localPath)
	}

	get syncRecord() {
		return new SyncRecord(this.vault, this.options.remoteBaseDir)
	}

	abstract exec(): Promise<boolean>
}
