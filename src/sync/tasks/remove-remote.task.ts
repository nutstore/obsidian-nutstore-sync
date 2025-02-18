import consola from 'consola'
import { BaseTask } from './task.interface'

export default class RemoveRemoteTask extends BaseTask {
	async exec() {
		try {
			await this.webdav.deleteFile(this.remotePath)
			return true
		} catch (e) {
			consola.error(e)
			return false
		}
	}
}
