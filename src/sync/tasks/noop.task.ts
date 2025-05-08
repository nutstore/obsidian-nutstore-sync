import { BaseTask } from './task.interface'

export default class NoopTask extends BaseTask {
	exec() {
		return {
			success: true,
		}
	}
}
