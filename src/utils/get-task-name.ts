import i18n from '~/i18n'
import ConflictResolveTask from '~/sync/tasks/conflict-resolve.task'
import FilenameErrorTask from '~/sync/tasks/filename-error.task'
import MkdirLocalTask from '~/sync/tasks/mkdir-local.task'
import MkdirRemoteTask from '~/sync/tasks/mkdir-remote.task'
import PullTask from '~/sync/tasks/pull.task'
import PushTask from '~/sync/tasks/push.task'
import RemoveLocalTask from '~/sync/tasks/remove-local.task'
import RemoveRemoteTask from '~/sync/tasks/remove-remote.task'
import { BaseTask } from '~/sync/tasks/task.interface'

export default function getTaskName(task: BaseTask) {
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
	return i18n.t('sync.fileOp.sync')
}
