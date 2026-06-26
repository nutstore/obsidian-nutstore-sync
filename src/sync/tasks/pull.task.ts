import { downloadRemoteFile } from '~/utils/chunked-download'
import logger from '~/utils/logger'
import { BaseTask, BaseTaskOptions, toTaskError } from './task.interface'

export default class PullTask extends BaseTask {
	constructor(
		readonly options: BaseTaskOptions & {
			remoteSize: number
			mobileAppDownloadFileChunkSize?: string
		},
	) {
		super(options)
	}

	get remoteSize() {
		return this.options.remoteSize
	}

	async exec() {
		try {
			logger.info(
				`[PullTask] ${this.remotePath} → ${this.localPath} (${this.remoteSize} bytes)`,
			)
			await downloadRemoteFile({
				vault: this.vault,
				webdav: this.webdav,
				remotePath: this.remotePath,
				localPath: this.localPath,
				remoteSize: this.remoteSize,
				mobileAppDownloadFileChunkSize:
					this.options.mobileAppDownloadFileChunkSize,
			})
			return { success: true } as const
		} catch (e) {
			logger.error(`[PullTask] failed: ${this.localPath}`, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
