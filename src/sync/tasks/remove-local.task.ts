import { BaseTask } from './task.interface'

export default class RemoveLocalTask extends BaseTask {
	async exec() {
		try {
			await this.vault.adapter.remove(this.localPath)
			return true
		} catch (e) {
			console.error(e)
			return false
		}
	}
}
