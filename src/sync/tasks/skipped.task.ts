import { BaseTask, BaseTaskOptions } from './task.interface'

export type SkippedTaskOptions = BaseTaskOptions &
	(
		| {
				reason: 'file-too-large'
				maxSize: number
				remoteSize: number
				localSize?: number
		  }
		| {
				reason: 'file-too-large'
				maxSize: number
				remoteSize?: number
				localSize: number
		  }
		| {
				reason: 'file-too-large'
				maxSize: number
				remoteSize: number
				localSize: number
		  }
	)

export default class SkippedTask extends BaseTask {
	constructor(readonly options: SkippedTaskOptions) {
		super(options)
	}

	exec() {
		return {
			success: true,
			skipRecord: true,
		}
	}
}
