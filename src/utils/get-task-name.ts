import i18n from '~/i18n'
import CleanRecordTask from '~/sync/tasks/clean-record.task'
import ConflictResolveTask from '~/sync/tasks/conflict-resolve.task'
import FilenameErrorTask from '~/sync/tasks/filename-error.task'
import MkdirLocalTask from '~/sync/tasks/mkdir-local.task'
import MkdirRemoteTask from '~/sync/tasks/mkdir-remote.task'
import MkdirsRemoteTask from '~/sync/tasks/mkdirs-remote.task'
import NoopTask from '~/sync/tasks/noop.task'
import PullTask from '~/sync/tasks/pull.task'
import PushTask from '~/sync/tasks/push.task'
import RemoveLocalTask from '~/sync/tasks/remove-local.task'
import RemoveRemoteRecursivelyTask from '~/sync/tasks/remove-remote-recursively.task'
import RemoveRemoteTask from '~/sync/tasks/remove-remote.task'
import SkippedTask, { SkipReason } from '~/sync/tasks/skipped.task'
import { BaseTask } from '~/sync/tasks/task.interface'

export type TaskKind =
	| 'cleanRecord'
	| 'merge'
	| 'filenameError'
	| 'createLocalDir'
	| 'createRemoteDir'
	| 'createRemoteDirs'
	| 'noop'
	| 'download'
	| 'upload'
	| 'removeLocal'
	| 'removeRemote'
	| 'removeRemoteRecursively'
	| 'skip'
	| 'sync'

/**
 * Everything needed to label a task after it has run. Unlike `BaseTask` it holds
 * no vault, client or record references, so it is cheap to keep in memory.
 */
export interface TaskDescriptor {
	kind: TaskKind
	skipReason?: SkipReason
}

export function describeTask(task: BaseTask): TaskDescriptor {
	if (task instanceof CleanRecordTask) return { kind: 'cleanRecord' }
	if (task instanceof ConflictResolveTask) return { kind: 'merge' }
	if (task instanceof FilenameErrorTask) return { kind: 'filenameError' }
	if (task instanceof MkdirLocalTask) return { kind: 'createLocalDir' }
	if (task instanceof MkdirRemoteTask) return { kind: 'createRemoteDir' }
	if (task instanceof MkdirsRemoteTask) return { kind: 'createRemoteDirs' }
	if (task instanceof NoopTask) return { kind: 'noop' }
	if (task instanceof PullTask) return { kind: 'download' }
	if (task instanceof PushTask) return { kind: 'upload' }
	if (task instanceof RemoveLocalTask) return { kind: 'removeLocal' }
	if (task instanceof RemoveRemoteTask) return { kind: 'removeRemote' }
	if (task instanceof RemoveRemoteRecursivelyTask) {
		return { kind: 'removeRemoteRecursively' }
	}
	if (task instanceof SkippedTask) {
		return { kind: 'skip', skipReason: task.options.reason }
	}
	return { kind: 'sync' }
}

const SKIP_REASON_KEYS = {
	[SkipReason.FileTooLarge]: 'sync.skipReason.file-too-large',
	[SkipReason.FolderContainsIgnoredItems]:
		'sync.skipReason.folder-contains-ignored-items',
	[SkipReason.ConflictInSendOnlyMode]:
		'sync.skipReason.conflict-in-send-only-mode',
	[SkipReason.ConflictInReceiveOnlyMode]:
		'sync.skipReason.conflict-in-receive-only-mode',
	[SkipReason.DeletedLocallyButChangedRemotely]:
		'sync.skipReason.deleted-locally-but-changed-remotely',
	[SkipReason.DeletedRemotelyButChangedLocally]:
		'sync.skipReason.deleted-remotely-but-changed-locally',
} as const satisfies Record<SkipReason, string>

/** Localized at call time, so a retained descriptor follows the current language. */
export function getTaskLabel({ kind, skipReason }: TaskDescriptor): string {
	if (kind === 'skip') {
		const reasonText = skipReason ? i18n.t(SKIP_REASON_KEYS[skipReason]) : ''
		return `${i18n.t('sync.fileOp.skip')}: ${reasonText}`
	}
	return i18n.t(`sync.fileOp.${kind}`)
}

export default function getTaskName(task: BaseTask) {
	return getTaskLabel(describeTask(task))
}
