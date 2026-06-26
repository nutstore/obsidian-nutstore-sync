import logger from '~/utils/logger'
import { BaseTask, toTaskError } from './task.interface'

export default class RemoveRemoteTask extends BaseTask {
	async exec() {
		try {
			logger.info(`[RemoveRemote] ${this.remotePath}`)
			await this.webdav.deleteFile(this.remotePath)
			return { success: true } as const
		} catch (e) {
			logger.error(`[RemoveRemote] failed: ${this.remotePath}`, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
