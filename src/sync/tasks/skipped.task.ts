import { BaseTask, BaseTaskOptions } from './task.interface'

export enum SkipReason {
	FileTooLarge = 'file-too-large',
	FolderContainsIgnoredItems = 'folder-contains-ignored-items',
	ConflictInSendOnlyMode = 'conflict-in-send-only-mode',
	ConflictInReceiveOnlyMode = 'conflict-in-receive-only-mode',
}

export type SkippedTaskReasonOptions =
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
	| {
			reason: SkipReason.ConflictInSendOnlyMode
	  }
	| {
			reason: SkipReason.ConflictInReceiveOnlyMode
	  }

export type SkippedTaskOptions = BaseTaskOptions & SkippedTaskReasonOptions

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
