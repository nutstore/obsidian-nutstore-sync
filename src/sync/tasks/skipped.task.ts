import { BaseTask, BaseTaskOptions } from './task.interface'

export enum SkipReason {
	FileTooLarge = 'file-too-large',
	FolderContainsIgnoredItems = 'folder-contains-ignored-items',
	ConflictInSendOnlyMode = 'conflict-in-send-only-mode',
	ConflictInReceiveOnlyMode = 'conflict-in-receive-only-mode',
	DeletedLocallyButChangedRemotely = 'deleted-locally-but-changed-remotely',
	DeletedRemotelyButChangedLocally = 'deleted-remotely-but-changed-locally',
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
	| {
			reason: SkipReason.DeletedLocallyButChangedRemotely
	  }
	| {
			reason: SkipReason.DeletedRemotelyButChangedLocally
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
