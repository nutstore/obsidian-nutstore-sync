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
	// Keep the last task for duplicate paths, matching the previous Map behavior.
	const tasksByPath = new Map<string, MkdirRemoteTask>()
	for (const task of mkdirTasks) {
		tasksByPath.set(task.remotePath, task)
	}

	const entries = [...tasksByPath.entries()]
	const isDescendant = (path: string, parent: string) =>
		path.startsWith(parent.endsWith('/') ? parent : `${parent}/`)
	const leaves = entries.filter(
		([path]) => !entries.some(([otherPath]) => isDescendant(otherPath, path)),
	)
	const assignedPaths = new Set<string>()

	return leaves.map(([leafPath, leafTask]) => {
		assignedPaths.add(leafPath)
		const additionalPaths = entries
			.filter(
				([path]) => !assignedPaths.has(path) && isDescendant(leafPath, path),
			)
			.map(([path, task]) => {
				assignedPaths.add(path)
				return {
					localPath: task.localPath,
					remotePath: path,
				}
			})

		return new MkdirsRemoteTask({
			...leafTask.options,
			additionalPaths,
		})
	})
}
