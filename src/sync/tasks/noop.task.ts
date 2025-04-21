import { BaseTask } from './task.interface'

export default class NoopTask extends BaseTask {
	async exec() {
		return {
			success: true,
		}
	}
}
