import type { SyncRecord } from '~/storage/sync-record'
import { isSub } from '~/utils/is-sub'
import CleanRecordTask from '../tasks/clean-record.task'
import MkdirRemoteTask from '../tasks/mkdir-remote.task'
import MoveRemoteTask from '../tasks/move-remote.task'
import PushTask from '../tasks/push.task'
import RemoveRemoteTask from '../tasks/remove-remote.task'
import { BaseTask } from '../tasks/task.interface'
import { mergeMkdirTasks } from './merge-mkdir-tasks'
import { mergeRemoveRemoteTasks } from './merge-remove-remote-tasks'

function mergeCleanRecordTasks(tasks: CleanRecordTask[]): CleanRecordTask[] {
	if (tasks.length <= 1) return tasks
	const byRecord = new Map<SyncRecord, CleanRecordTask[]>()
	for (const task of tasks) {
		const group = byRecord.get(task.syncRecord)
		if (group) group.push(task)
		else byRecord.set(task.syncRecord, [task])
	}
	const merged: CleanRecordTask[] = []
	for (const group of byRecord.values()) {
		if (group.length === 1) {
			merged.push(group[0])
			continue
		}
		const uniquePaths = new Set<string>()
		for (const task of group) {
			for (const p of task.getAllPaths()) {
				uniquePaths.add(p)
			}
		}
		const [firstPath, ...additionalPaths] = uniquePaths
		merged.push(
			new CleanRecordTask({
				...group[0].options,
				localPath: firstPath,
				remotePath: firstPath,
				additionalPaths,
			}),
		)
	}
	return merged
}

function coversPath(container: string, target: string): boolean {
	return target === container || isSub(container, target)
}

function overlapsPath(a: string, b: string): boolean {
	return a === b || isSub(a, b) || isSub(b, a)
}

/**
 * Reorders and compacts confirmed sync tasks into a dependency-safe execution order:
 * 1. Pre-write remote deletions (file/folder type replacements that do not cover any move source)
 * 2. Merged remote directory creations (ensuring move/push parents exist)
 * 3. Remote file moves (before old parent folders are deleted)
 * 4. Remaining tasks (push, pull, conflict, local mkdir, local delete, merged clean-record, etc.)
 * 5. Merged post-move remote deletions (empty old directories and deleted files)
 */
export function optimizeTasksForExecution(
	tasks: readonly BaseTask[],
	options?: {
		cancelledMoveSources?: ReadonlySet<string>
	},
): BaseTask[] {
	const cancelledMoveSources = options?.cancelledMoveSources
	const cleanRecordTasks: CleanRecordTask[] = []
	const mkdirTasks: MkdirRemoteTask[] = []
	const moveRemoteTasks: MoveRemoteTask[] = []
	const removeRemoteTasks: RemoveRemoteTask[] = []
	const otherTasks: BaseTask[] = []

	for (const task of tasks) {
		if (task instanceof CleanRecordTask) {
			cleanRecordTasks.push(task)
		} else if (task instanceof MkdirRemoteTask) {
			mkdirTasks.push(task)
		} else if (task instanceof MoveRemoteTask) {
			moveRemoteTasks.push(task)
		} else if (task instanceof RemoveRemoteTask) {
			removeRemoteTasks.push(task)
		} else {
			otherTasks.push(task)
		}
	}

	const safeRemoveRemoteTasks =
		cancelledMoveSources && cancelledMoveSources.size > 0
			? removeRemoteTasks.filter(
					(removeTask) =>
						![...cancelledMoveSources].some((src) =>
							coversPath(removeTask.localPath, src),
						),
				)
			: removeRemoteTasks

	const writeTargetPaths: string[] = [
		...mkdirTasks.map((t) => t.localPath),
		...moveRemoteTasks.map((t) => t.localPath),
		...otherTasks.filter((t) => t instanceof PushTask).map((t) => t.localPath),
	]
	const activeMoveSources = moveRemoteTasks.map((t) => t.fromLocalPath)

	const preRemoveRemoteTasks: RemoveRemoteTask[] = []
	const postRemoveRemoteTasks: RemoveRemoteTask[] = []
	for (const removeTask of safeRemoveRemoteTasks) {
		const touchesWriteTarget = writeTargetPaths.some((target) =>
			overlapsPath(removeTask.localPath, target),
		)
		const coversMoveSource = activeMoveSources.some((src) =>
			coversPath(removeTask.localPath, src),
		)
		if (touchesWriteTarget && !coversMoveSource) {
			preRemoveRemoteTasks.push(removeTask)
		} else {
			postRemoveRemoteTasks.push(removeTask)
		}
	}

	const mergedPreRemoveRemoteTasks =
		mergeRemoveRemoteTasks(preRemoveRemoteTasks)
	const mergedMkdirTasks = mergeMkdirTasks(mkdirTasks)
	const mergedCleanRecordTasks = mergeCleanRecordTasks(cleanRecordTasks)
	const mergedPostRemoveRemoteTasks = mergeRemoveRemoteTasks(
		postRemoveRemoteTasks,
	)

	return [
		...mergedPreRemoveRemoteTasks,
		...mergedMkdirTasks,
		...moveRemoteTasks,
		...otherTasks,
		...mergedCleanRecordTasks,
		...mergedPostRemoveRemoteTasks,
	]
}
