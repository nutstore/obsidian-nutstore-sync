import { describe, expect, it } from 'vitest'
import type { BaseTaskOptions } from '../tasks/task.interface'
import MkdirRemoteTask from '../tasks/mkdir-remote.task'
import { mergeMkdirTasks } from './merge-mkdir-tasks'

function mkdir(remotePath: string): MkdirRemoteTask {
	return new MkdirRemoteTask({
		remotePath,
		localPath: remotePath.slice(1),
		remoteBaseDir: '/',
		vault: {},
		webdav: {},
		syncRecord: {},
		logger: {},
	} as BaseTaskOptions)
}

function createdPaths(tasks: ReturnType<typeof mergeMkdirTasks>) {
	return tasks.map((task) => task.remotePath).sort()
}

function recordedPaths(tasks: ReturnType<typeof mergeMkdirTasks>) {
	return tasks.flatMap((task) =>
		task.getAllPaths().map((item) => item.remotePath),
	)
}

describe('mergeMkdirTasks', () => {
	it.each([
		['children before parent', ['/a/b', '/a/c', '/a']],
		['parent before children', ['/a', '/a/b', '/a/c']],
	])('keeps a create operation for every sibling leaf: %s', (_, paths) => {
		const merged = mergeMkdirTasks(paths.map(mkdir))

		expect(createdPaths(merged)).toEqual(['/a/b', '/a/c'])
		expect(recordedPaths(merged).sort()).toEqual(['/a', '/a/b', '/a/c'])
	})

	it('merges a single ancestor chain into its deepest operation', () => {
		const merged = mergeMkdirTasks(['/a/b', '/a', '/a/b/c'].map(mkdir))

		expect(createdPaths(merged)).toEqual(['/a/b/c'])
		expect(recordedPaths(merged).sort()).toEqual(['/a', '/a/b', '/a/b/c'])
	})

	it('does not merge paths that only share a string prefix', () => {
		const merged = mergeMkdirTasks(['/a', '/ab'].map(mkdir))

		expect(createdPaths(merged)).toEqual(['/a', '/ab'])
	})
})
