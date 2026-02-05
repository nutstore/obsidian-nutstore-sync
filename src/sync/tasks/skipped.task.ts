import { BaseTask, BaseTaskOptions } from './task.interface'

export enum SkipReason {
	FileTooLarge = 'file-too-large',
	FolderContainsIgnoredItems = 'folder-contains-ignored-items',
}

export type SkippedTaskOptions = BaseTaskOptions &
	(
		| {
				reason: SkipReason.FileTooLarge
				maxSize: number
				remoteSize: number
				localSize?: number
		  }
		| {
				reason: SkipReason.FileTooLarge
				maxSize: number
				remoteSize?: number
				localSize: number
		  }
		| {
				reason: SkipReason.FileTooLarge
				maxSize: number
				remoteSize: number
				localSize: number
		  }
		| {
				reason: SkipReason.FolderContainsIgnoredItems
				ignoredPaths: string[]
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
		} as const
	}
}
