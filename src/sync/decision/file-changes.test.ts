import { describe, expect, it, vi } from 'vitest'
import { SyncMode } from '~/settings'
import type { ConflictStrategy } from '../tasks/conflict-resolve.task'
import { getFileChanges } from '../core/file-changes'
import { sendOnlyDecider } from './send-only.decider'
import { receiveOnlyDecider } from './receive-only.decider'
import { twoWayDecider } from './two-way.decider'
import type { SyncDecisionInput, TaskFactory } from './sync-decision.interface'

// Planning tests isolate the Obsidian runtime; task creation is observed below.
vi.mock('~/settings', () => ({
	SyncMode: { LOOSE: 'loose', STRICT: 'strict' },
}))
vi.mock('./base.decider', () => ({ default: class {} }))
vi.mock('../tasks/task.interface', () => ({ BaseTask: class {} }))

function fixture(path: string, content: string, remoteChanged = false) {
	const bytes = new TextEncoder().encode(content)
	const local = {
		path,
		basename: path,
		isDir: false as const,
		isDeleted: false,
		mtime: 2,
		size: bytes.byteLength,
	}
	const remote = { ...local, mtime: remoteChanged ? 2 : 1 }
	const record = {
		local: { ...local, mtime: 1 },
		remote: { ...remote, mtime: 1 },
		base: { key: 'baseline' },
	}
	const taskFactory = {
		createPullTask: vi.fn<TaskFactory['createPullTask']>(),
		createPushTask: vi.fn<TaskFactory['createPushTask']>(),
		createConflictResolveTask:
			vi.fn<TaskFactory['createConflictResolveTask']>(),
		createNoopTask: vi.fn<TaskFactory['createNoopTask']>(),
		createRemoveLocalTask: vi.fn<TaskFactory['createRemoveLocalTask']>(),
		createRemoveRemoteTask: vi.fn<TaskFactory['createRemoveRemoteTask']>(),
		createMkdirLocalTask: vi.fn<TaskFactory['createMkdirLocalTask']>(),
		createMkdirRemoteTask: vi.fn<TaskFactory['createMkdirRemoteTask']>(),
		createCleanRecordTask: vi.fn<TaskFactory['createCleanRecordTask']>(),
		createFilenameErrorTask: vi.fn<TaskFactory['createFilenameErrorTask']>(),
		createSkippedTask: vi.fn<TaskFactory['createSkippedTask']>(),
	}
	const input = {
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		settings: {
			skipLargeFiles: { maxSize: '' },
			mobileAppDownloadFileChunkSize: '',
			conflictStrategy: 'diff3' as ConflictStrategy,
			syncMode: SyncMode.LOOSE,
			configDir: '.obsidian',
		},
		localStats: [{ stat: local, ignored: false }],
		remoteStats: [{ stat: remote, ignored: false }],
		syncRecords: new Map([[path, record]]),
		remoteBaseDir: '/sync/',
		getBaseContent: vi.fn(
			async (): Promise<ArrayBuffer | null> => bytes.buffer,
		),
		compareFileContent: vi.fn(async (_path: string, base: ArrayBuffer) =>
			new Uint8Array(base).every((byte, index) => byte === bytes[index]),
		),
		taskFactory,
	} satisfies SyncDecisionInput
	return { input, local, remote, record, taskFactory }
}

describe.each([
	['note.md', 'A neutral note'],
	['笔记.md', '一条普通笔记'],
	['记录🌱.md', 'Note 笔记 🌱'],
])('file changes: %s', (path, content) => {
	it('all policies ignore a timestamp-only local rewrite', async () => {
		const { input, taskFactory } = fixture(path, content)
		await twoWayDecider(input)
		await sendOnlyDecider(input, { overrideChanges: false })
		await sendOnlyDecider(input, { overrideChanges: true })
		await receiveOnlyDecider(input, { revertLocalChanges: false })
		await receiveOnlyDecider(input, { revertLocalChanges: true })
		expect(taskFactory.createPushTask).not.toHaveBeenCalled()
		expect(taskFactory.createPullTask).not.toHaveBeenCalled()
		expect(taskFactory.createSkippedTask).not.toHaveBeenCalled()
		expect(input.logger.debug).toHaveBeenCalledWith(
			expect.objectContaining({
				contentCheck: 'content-equal',
				localMtimeChanged: true,
				localChanged: false,
			}),
		)
	})
	it('receives a remote update despite a timestamp-only local rewrite', async () => {
		const { input, taskFactory } = fixture(path, content, true)
		await receiveOnlyDecider(input, { revertLocalChanges: false })
		expect(taskFactory.createPullTask).toHaveBeenCalledOnce()
		expect(taskFactory.createSkippedTask).not.toHaveBeenCalled()
	})
	it('uploads real local changes and preserves real conflicts', async () => {
		const { input, taskFactory, remote } = fixture(path, content)
		input.compareFileContent.mockResolvedValue(false)
		await sendOnlyDecider(input, { overrideChanges: false })
		expect(taskFactory.createPushTask).toHaveBeenCalledOnce()
		remote.mtime = 2
		await receiveOnlyDecider(input, { revertLocalChanges: false })
		expect(taskFactory.createSkippedTask).toHaveBeenCalledOnce()
		expect(taskFactory.createPullTask).not.toHaveBeenCalled()
	})
	it('falls back to metadata when the baseline is unavailable', async () => {
		const { input, local, remote, record } = fixture(path, content)
		input.getBaseContent.mockResolvedValue(null)
		expect(await getFileChanges(input, local, remote, record)).toEqual({
			localChanged: true,
			remoteChanged: false,
		})
		expect(input.compareFileContent).not.toHaveBeenCalled()
	})
	it('avoids reading content when size differs', async () => {
		const { input, local, remote, record } = fixture(path, content)
		local.size += 1
		expect(await getFileChanges(input, local, remote, record)).toEqual({
			localChanged: true,
			remoteChanged: false,
		})
		expect(input.getBaseContent).not.toHaveBeenCalled()
	})
})
