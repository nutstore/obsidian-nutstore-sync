import consola from 'consola'
import { BaseTask, toTaskError } from './task.interface'

export default class RemoveRemoteTask extends BaseTask {
	async exec() {
		try {
			await this.webdav.deleteFile(this.remotePath)
			return { success: true }
		} catch (e) {
			consola.error(e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
