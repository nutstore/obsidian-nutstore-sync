import { describe, expect, it } from 'vitest'
import RemoveRemoteTask from '../tasks/remove-remote.task'
import { mergeRemoveRemoteTasks } from './merge-remove-remote-tasks'

function removeRemote(remotePath: string): RemoveRemoteTask {
	return new RemoveRemoteTask({
		remotePath,
		localPath: remotePath,
		remoteBaseDir: '/vault/',
	} as ConstructorParameters<typeof RemoveRemoteTask>[0])
}

describe('mergeRemoveRemoteTasks', () => {
	it('skips malformed paths while retaining neutral English and Chinese paths', () => {
		const malformedTask = {
			options: {
				remotePath: undefined,
				remoteBaseDir: '/vault/',
			},
		} as unknown as RemoveRemoteTask

		const result = mergeRemoveRemoteTasks([
			malformedTask,
			removeRemote('notes/example.md'),
			removeRemote('文档/示例.md'),
		])

		expect(result.map((task) => task.remotePath).sort()).toEqual([
			'/vault/notes/example.md',
			'/vault/文档/示例.md',
		])
	})
})
