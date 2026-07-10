import { BaseTask, toTaskError } from './task.interface'

export default class RemoveRemoteRecursivelyTask extends BaseTask {
	async exec() {
		try {
			await this.webdav.deleteFile(this.remotePath)
			return { success: true } as const
		} catch (e) {
			this.logger.error(e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
