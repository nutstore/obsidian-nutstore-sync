import i18n from '~/i18n'
import ConflictResolveTask from '~/sync/tasks/conflict-resolve.task'
import MkdirLocalTask from '~/sync/tasks/mkdir-local.task'
import MkdirRemoteTask from '~/sync/tasks/mkdir-remote.task'
import PullTask from '~/sync/tasks/pull.task'
import PushTask from '~/sync/tasks/push.task'
import RemoveLocalTask from '~/sync/tasks/remove-local.task'
import RemoveRemoteTask from '~/sync/tasks/remove-remote.task'
import { BaseTask } from '~/sync/tasks/task.interface'

export default function getTaskName(task: BaseTask) {
	if (task instanceof PullTask) {
		return i18n.t('sync.fileOp.pull')
	} else if (task instanceof PushTask) {
		return i18n.t('sync.fileOp.push')
	} else if (
		task instanceof MkdirLocalTask ||
		task instanceof MkdirRemoteTask
	) {
		return i18n.t('sync.fileOp.mkdir')
	} else if (
		task instanceof RemoveLocalTask ||
		task instanceof RemoveRemoteTask
	) {
		return i18n.t('sync.fileOp.remove')
	} else if (task instanceof ConflictResolveTask) {
		return i18n.t('sync.fileOp.conflict')
	} else {
		return i18n.t('sync.fileOp.sync')
	}
}
