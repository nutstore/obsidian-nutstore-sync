import { normalize } from 'path-browserify'
import { isSub } from '~/utils/is-sub'
import RemoveRemoteRecursivelyTask from '../tasks/remove-remote-recursively.task'
import RemoveRemoteTask from '../tasks/remove-remote.task'

export function mergeRemoveRemoteTasks(
	tasks: RemoveRemoteTask[],
): RemoveRemoteRecursivelyTask[] {
	if (tasks.length === 0) return []

	// 过滤掉空路径或无效任务
	const validTasks = tasks.filter((task) => {
		const path = normalize(task.remotePath)
		return path !== '' && path !== '.'
	})

	if (validTasks.length === 0) return []

	// 按路径长度排序，短的在前（父路径优先）
	// 如果长度相同，按字典序排序，保证结果稳定
	const sortedTasks = [...validTasks].sort((a, b) => {
		const pathA = normalize(a.remotePath)
		const pathB = normalize(b.remotePath)
		if (pathA.length !== pathB.length) {
			return pathA.length - pathB.length
		}
		return pathA.localeCompare(pathB)
	})

	const result: RemoveRemoteRecursivelyTask[] = []
	const selectedPaths: string[] = []

	for (const task of sortedTasks) {
		const path = normalize(task.remotePath)

		// 检查当前路径是否是已选路径的子路径或重复路径
		const shouldSkip = selectedPaths.some((parentPath) => {
			if (path === parentPath) {
				return true
			}
			return isSub(parentPath, path)
		})

		if (!shouldSkip) {
			selectedPaths.push(path)
			result.push(new RemoveRemoteRecursivelyTask(task.options))
		}
	}

	return result
}
