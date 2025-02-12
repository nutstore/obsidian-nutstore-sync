import { BaseTask } from './task.interface'

export default class RemoveRemoteTask extends BaseTask {
	async exec() {
		try {
			await this.webdav.deleteFile(this.remotePath)
			return true
		} catch (e) {
			console.error(e)
			return false
		}
	}
}
