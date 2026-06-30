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

export default function getTaskName(task: BaseTask) {
	if (task instanceof CleanRecordTask) {
		return i18n.t('sync.fileOp.cleanRecord')
	}
	if (task instanceof ConflictResolveTask) {
		return i18n.t('sync.fileOp.merge')
	}
	if (task instanceof FilenameErrorTask) {
		return i18n.t('sync.fileOp.filenameError')
	}
	if (task instanceof MkdirLocalTask) {
		return i18n.t('sync.fileOp.createLocalDir')
	}
	if (task instanceof MkdirRemoteTask) {
		return i18n.t('sync.fileOp.createRemoteDir')
	}
	if (task instanceof MkdirsRemoteTask) {
		return i18n.t('sync.fileOp.createRemoteDirs')
	}
	if (task instanceof NoopTask) {
		return i18n.t('sync.fileOp.noop')
	}
	if (task instanceof PullTask) {
		return i18n.t('sync.fileOp.download')
	}
	if (task instanceof PushTask) {
		return i18n.t('sync.fileOp.upload')
	}
	if (task instanceof RemoveLocalTask) {
		return i18n.t('sync.fileOp.removeLocal')
	}
	if (task instanceof RemoveRemoteTask) {
		return i18n.t('sync.fileOp.removeRemote')
	}
	if (task instanceof RemoveRemoteRecursivelyTask) {
		return i18n.t('sync.fileOp.removeRemoteRecursively')
	}
	if (task instanceof SkippedTask) {
		const reasonText = (() => {
			if (task.options.reason === SkipReason.FileTooLarge) {
				return i18n.t('sync.skipReason.file-too-large')
			} else if (
				task.options.reason === SkipReason.FolderContainsIgnoredItems
			) {
				return i18n.t('sync.skipReason.folder-contains-ignored-items')
			} else if (task.options.reason === SkipReason.ConflictInSendOnlyMode) {
				return i18n.t('sync.skipReason.conflict-in-send-only-mode')
			} else if (task.options.reason === SkipReason.ConflictInReceiveOnlyMode) {
				return i18n.t('sync.skipReason.conflict-in-receive-only-mode')
			} else if (
				task.options.reason === SkipReason.DeletedLocallyButChangedRemotely
			) {
				return i18n.t('sync.skipReason.deleted-locally-but-changed-remotely')
			} else if (
				task.options.reason === SkipReason.DeletedRemotelyButChangedLocally
			) {
				return i18n.t('sync.skipReason.deleted-remotely-but-changed-locally')
			}
		})()
		return `${i18n.t('sync.fileOp.skip')}: ${reasonText}`
	}
	return i18n.t('sync.fileOp.sync')
}
