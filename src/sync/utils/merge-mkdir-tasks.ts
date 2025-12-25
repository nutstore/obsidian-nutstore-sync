import MkdirRemoteTask from '../tasks/mkdir-remote.task'
import MkdirsRemoteTask from '../tasks/mkdirs-remote.task'

/**
 * Merge mkdir tasks that have parent-child relationships into MkdirsRemoteTask.
 * All tasks are converted to MkdirsRemoteTask, with additionalPaths empty if no merge needed.
 *
 * @example
 * Given [/a, /a/b, /a/b/c] → MkdirsRemoteTask with /a/b/c as main path and additionalPaths: [/a, /a/b]
 *
 * @example
 * Given [/a, /x] → Two MkdirsRemoteTask with empty additionalPaths
 *
 * @param mkdirTasks - Array of MkdirRemoteTask to merge
 * @returns Array of MkdirsRemoteTask (additionalPaths may be empty)
 */
export function mergeMkdirTasks(
	mkdirTasks: MkdirRemoteTask[],
): MkdirsRemoteTask[] {
	if (mkdirTasks.length === 0) {
		return []
	}

	// Group mkdir tasks by their path hierarchy
	// Key: deepest path, Value: all paths in the hierarchy (including parents)
	const hierarchyGroups = new Map<
		string,
		Array<{ task: MkdirRemoteTask; remotePath: string }>
	>()

	for (const task of mkdirTasks) {
		const remotePath = task.remotePath
		let foundParent = false

		// Check if this task is a child of any existing group
		for (const [deepestPath, group] of hierarchyGroups.entries()) {
			if (remotePath.startsWith(deepestPath + '/')) {
				// This is a child, so deepestPath should be replaced with this path
				hierarchyGroups.delete(deepestPath)
				group.push({ task, remotePath })
				hierarchyGroups.set(remotePath, group)
				foundParent = true
				break
			}
		}

		if (!foundParent) {
			// Check if any existing group is a child of this task
			let childGroups: Array<{
				task: MkdirRemoteTask
				remotePath: string
			}> = []
			const groupsToDelete: string[] = []

			for (const [deepestPath, group] of hierarchyGroups.entries()) {
				if (deepestPath.startsWith(remotePath + '/')) {
					// Existing group is a child of this task
					childGroups = childGroups.concat(group)
					groupsToDelete.push(deepestPath)
				}
			}

			// Delete child groups and create new group with this task
			for (const key of groupsToDelete) {
				hierarchyGroups.delete(key)
			}

			if (childGroups.length > 0) {
				// This task is a parent of existing groups
				childGroups.push({ task, remotePath })
				// Find the deepest path among all
				const deepest = childGroups.reduce((max, item) =>
					item.remotePath.length > max.remotePath.length ? item : max,
				)
				hierarchyGroups.set(deepest.remotePath, childGroups)
			} else {
				// This task is independent
				hierarchyGroups.set(remotePath, [{ task, remotePath }])
			}
		}
	}

	// Create merged tasks - all converted to MkdirsRemoteTask
	const mergedTasks: MkdirsRemoteTask[] = []

	for (const group of hierarchyGroups.values()) {
		// Find the deepest path
		const deepestItem = group.reduce((max, item) =>
			item.remotePath.length > max.remotePath.length ? item : max,
		)

		// All other paths are additional paths (empty if group.length === 1)
		const additionalPaths = group
			.filter((item) => item !== deepestItem)
			.map((item) => ({
				localPath: item.task.localPath,
				remotePath: item.task.remotePath,
			}))

		const mkdirsTask = new MkdirsRemoteTask({
			...deepestItem.task.options,
			additionalPaths,
		})

		mergedTasks.push(mkdirsTask)
	}

	return mergedTasks
}
