import { describe, expect, it, vi } from 'vitest'
import type { Vault, FileManager } from 'obsidian'
import type { WebDAVClient } from 'webdav'
import type { SyncRecord } from '~/storage/sync-record'
import { SyncScope } from './scope'
import { taskAllowedByScope } from './task-scope'
import type { BaseTaskOptions } from './tasks/task.interface'
import RemoveLocalTask from './tasks/remove-local.task'
import RemoveRemoteTask from './tasks/remove-remote.task'
import PushTask from './tasks/push.task'
import PullTask from './tasks/pull.task'
import ConflictResolveTask, {
	ConflictStrategy,
} from './tasks/conflict-resolve.task'
import MkdirRemoteTask from './tasks/mkdir-remote.task'
import MkdirsRemoteTask from './tasks/mkdirs-remote.task'
import { mergeRemoveRemoteTasks } from './utils/merge-remove-remote-tasks'

vi.mock('obsidian', () => ({
	TFile: class {},
	normalizePath: (path: string) => path,
}))

const options: BaseTaskOptions = {
	vault: {} as Vault,
	webdav: {} as WebDAVClient,
	syncRecord: {} as SyncRecord,
	logger: { info() {}, debug() {}, warn() {}, error() {} },
	remoteBaseDir: '/remote/',
	remotePath: '',
	localPath: '',
}

describe.each(['Notes/Section', '笔记/小节', 'Notes 笔记🌱/Section 小节📘'])(
	'mutation boundaries: %s',
	(root) => {
		const parent = root.slice(0, root.lastIndexOf('/'))
		const sibling = `${root}-archive/Example 示例🌿.bin`
		it('blocks replacement and recursive deletion of the protected root, its children and its ancestors', () => {
			const scope = new SyncScope()
			scope.protect(`/${root}/`)
			for (const path of [
				parent,
				root,
				`${root}/Example 示例🌿.bin`,
				sibling,
			]) {
				const base = { ...options, localPath: path, remotePath: path }
				const removeRemote = new RemoveRemoteTask(base)
				const tasks = [
					new RemoveLocalTask({
						...base,
						fileManager: {} as FileManager,
						recursive: true,
					}),
					removeRemote,
					...mergeRemoveRemoteTasks([removeRemote]),
					new PushTask(base),
					new PullTask({ ...base, remoteSize: 0 }),
					new ConflictResolveTask({
						...base,
						strategy: ConflictStrategy.LocalPriority,
					}),
				]
				for (const task of tasks)
					expect(
						taskAllowedByScope(task, scope),
						`${task.constructor.name}: ${path}`,
					).toBe(path === sibling)
			}
		})

		it('allows parent directory creation but rejects any merged mkdir that contains a protected path', () => {
			const scope = new SyncScope()
			scope.protect(root)
			const base = { ...options, localPath: parent, remotePath: parent }
			expect(taskAllowedByScope(new MkdirRemoteTask(base), scope)).toBe(true)
			for (const path of [root, sibling]) {
				const task = new MkdirsRemoteTask({
					...base,
					additionalPaths: [{ localPath: path, remotePath: path }],
				})
				expect(taskAllowedByScope(task, scope)).toBe(path === sibling)
			}
		})
	},
)
