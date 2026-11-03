import type { SyncScope } from './scope'
import type { BaseTask } from './tasks/task.interface'
import MkdirLocalTask from './tasks/mkdir-local.task'
import MkdirRemoteTask from './tasks/mkdir-remote.task'
import MkdirsRemoteTask from './tasks/mkdirs-remote.task'
import NoopTask from './tasks/noop.task'
import SkippedTask from './tasks/skipped.task'
import CleanRecordTask from './tasks/clean-record.task'

/** All writes may replace a directory; only non-destructive operations are exempt. */
export function taskAllowedByScope(task: BaseTask, scope: SyncScope): boolean {
	if (task instanceof MkdirsRemoteTask) {
		return task.getAllPaths().every(({ localPath }) => scope.allows(localPath))
	}
	const subtree = !(
		task instanceof MkdirLocalTask ||
		task instanceof MkdirRemoteTask ||
		task instanceof NoopTask ||
		task instanceof SkippedTask ||
		task instanceof CleanRecordTask
	)
	return scope.allows(task.localPath, subtree)
}
