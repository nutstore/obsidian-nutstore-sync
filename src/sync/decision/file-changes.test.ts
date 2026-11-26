import { describe, expect, it, vi } from 'vitest'
import { SyncMode } from '~/settings'
import type { ConflictStrategy } from '../tasks/conflict-resolve.task'
import { evaluateRemoteFileChange, getFileChanges } from '../core/file-changes'
import { hasFolderContentChanged } from '../core/has-folder-content-changed'
import { SkipReason } from '../tasks/skipped.task'
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

function fixture(
	path: string,
	content: string,
	options: {
		remoteChanged?: boolean
		remoteEtag?: string | null
		recordedRemoteEtag?: string | null
		remoteMtime?: number
		remoteSize?: number
	} = {},
) {
	const bytes = new TextEncoder().encode(content)
	const local = {
		path,
		basename: path,
		isDir: false as const,
		isDeleted: false,
		mtime: 2,
		size: bytes.byteLength,
	}
	const remote = {
		...local,
		mtime: options.remoteMtime ?? (options.remoteChanged ? 2 : 1),
		size: options.remoteSize ?? bytes.byteLength,
		etag:
			options.remoteEtag !== undefined
				? options.remoteEtag
				: options.remoteChanged
					? 'etag-v2'
					: 'etag-v1',
	}
	const record = {
		local: { ...local, mtime: 1 },
		remote: {
			...local,
			mtime: 1,
			...(options.recordedRemoteEtag === undefined
				? { etag: 'etag-v1' }
				: options.recordedRemoteEtag === null
					? {}
					: { etag: options.recordedRemoteEtag }),
		},
		base: { key: 'baseline' },
	}
	const taskFactory = {
		createPullTask: vi.fn<TaskFactory['createPullTask']>(),
		createPushTask: vi.fn<TaskFactory['createPushTask']>(),
		createMoveRemoteTask: vi.fn<TaskFactory['createMoveRemoteTask']>(),
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
		getLocalContentHash: vi.fn(async () => null),
		taskFactory,
	} satisfies SyncDecisionInput
	return { input, local, remote, record, taskFactory }
}

describe.each([
	['note.md', 'A neutral note'],
	['笔记.md', '一条普通笔记'],
	['记录🌱.md', 'Note 笔记 🌱'],
	['进度 100% & #1 📘.md', 'Progress note 100% & #1'],
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

	it('ignores remote mtime drift when remote ETag matches baseline', async () => {
		const { input, taskFactory } = fixture(path, content, {
			remoteMtime: 9999,
			remoteEtag: 'etag-v1',
			recordedRemoteEtag: 'etag-v1',
		})
		await twoWayDecider(input)
		await receiveOnlyDecider(input, { revertLocalChanges: false })
		expect(taskFactory.createPullTask).not.toHaveBeenCalled()
		expect(taskFactory.createConflictResolveTask).not.toHaveBeenCalled()
	})

	it('detects remote change when ETag differs even if size and mtime match', async () => {
		const { input, taskFactory } = fixture(path, content, {
			remoteMtime: 1,
			remoteEtag: 'etag-v2',
			recordedRemoteEtag: 'etag-v1',
		})
		await receiveOnlyDecider(input, { revertLocalChanges: false })
		expect(taskFactory.createPullTask).toHaveBeenCalledWith(
			expect.objectContaining({
				localPath: path,
				expectedRemoteStat: expect.objectContaining({ etag: 'etag-v2' }),
			}),
		)
	})

	it('receives a remote update despite a timestamp-only local rewrite', async () => {
		const { input, taskFactory } = fixture(path, content, {
			remoteChanged: true,
		})
		await receiveOnlyDecider(input, { revertLocalChanges: false })
		expect(taskFactory.createPullTask).toHaveBeenCalledOnce()
		expect(taskFactory.createSkippedTask).not.toHaveBeenCalled()
	})

	it('uploads real local changes with expectedRemoteEtag and preserves real conflicts', async () => {
		const { input, taskFactory, remote } = fixture(path, content)
		input.compareFileContent.mockResolvedValue(false)
		await sendOnlyDecider(input, { overrideChanges: false })
		expect(taskFactory.createPushTask).toHaveBeenCalledWith(
			expect.objectContaining({
				localPath: path,
				expectedRemoteEtag: 'etag-v1',
			}),
		)
		remote.etag = 'etag-v2'
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
			remoteStatus: 'unchanged',
			remoteChanged: false,
		})
		expect(input.compareFileContent).not.toHaveBeenCalled()
	})

	it('avoids reading content when size differs', async () => {
		const { input, local, remote, record } = fixture(path, content)
		local.size += 1
		expect(await getFileChanges(input, local, remote, record)).toEqual({
			localChanged: true,
			remoteStatus: 'unchanged',
			remoteChanged: false,
		})
		expect(input.getBaseContent).not.toHaveBeenCalled()
	})

	it('treats legacy record lacking remote.etag with matching size/mtime as unverified and blocks unsafe overwrite or deletion', async () => {
		const f1 = fixture(path, content, {
			remoteMtime: 1,
			remoteEtag: 'etag-replaced-same-size-mtime',
			recordedRemoteEtag: null,
		})
		expect(evaluateRemoteFileChange(f1.remote, f1.record.remote)).toBe(
			'unverified',
		)
		// Unchanged locally -> no download storm, no backfill
		await twoWayDecider(f1.input)
		expect(f1.taskFactory.createPullTask).not.toHaveBeenCalled()
		expect(f1.taskFactory.createPushTask).not.toHaveBeenCalled()
		expect(f1.record.remote.isDir).toBe(false)
		if (!f1.record.remote.isDir) {
			expect(f1.record.remote.etag).toBeUndefined()
		}

		// Local edit against unverified legacy remote -> TwoWay conflicts (never blind push), SendOnly skips
		const f2 = fixture(path, content, {
			remoteMtime: 1,
			remoteEtag: 'etag-replaced-same-size-mtime',
			recordedRemoteEtag: null,
		})
		f2.input.compareFileContent.mockResolvedValue(false)
		await twoWayDecider(f2.input)
		expect(f2.taskFactory.createPushTask).not.toHaveBeenCalled()
		expect(f2.taskFactory.createConflictResolveTask).toHaveBeenCalledOnce()

		await sendOnlyDecider(f2.input, { overrideChanges: false })
		expect(f2.taskFactory.createPushTask).not.toHaveBeenCalled()
		expect(f2.taskFactory.createSkippedTask).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: SkipReason.ConflictInSendOnlyMode,
			}),
		)

		// Local deleted against unverified legacy remote -> TwoWay restores rather than deleting remote, SendOnly protects
		const f3 = fixture(path, content, {
			remoteMtime: 1,
			remoteEtag: 'etag-replaced-same-size-mtime',
			recordedRemoteEtag: null,
		})
		f3.input.localStats = []
		await twoWayDecider(f3.input)
		expect(f3.taskFactory.createRemoveRemoteTask).not.toHaveBeenCalled()
		expect(f3.taskFactory.createPullTask).toHaveBeenCalledOnce()

		await sendOnlyDecider(f3.input, { overrideChanges: false })
		expect(f3.taskFactory.createRemoveRemoteTask).not.toHaveBeenCalled()
		expect(f3.taskFactory.createSkippedTask).toHaveBeenCalledWith(
			expect.objectContaining({
				reason: SkipReason.DeletedLocallyButChangedRemotely,
			}),
		)
	})

	it('treats folders containing unverified remote files as changed so remote folders are not deleted', () => {
		const folder = 'folder-章节📘'
		const filePath = `${folder}/${path}`
		const { remote, record } = fixture(filePath, content, {
			remoteMtime: 1,
			remoteEtag: 'etag-new',
			recordedRemoteEtag: null,
		})
		const records = new Map([[filePath, record]])
		expect(hasFolderContentChanged(folder, [remote], records, 'remote')).toBe(
			true,
		)
	})

	it('treats folders as changed when a recorded file is replaced by a directory at the same path', () => {
		const folder = 'folder-章节📘'
		const filePath = `${folder}/${path}`
		const { record } = fixture(filePath, content)
		const records = new Map([[filePath, record]])
		const replacementDir = {
			path: filePath,
			basename: path,
			isDir: true as const,
			isDeleted: false,
			mtime: 2,
		}
		expect(
			hasFolderContentChanged(folder, [replacementDir], records, 'remote'),
		).toBe(true)
		expect(
			hasFolderContentChanged(folder, [replacementDir], records, 'local'),
		).toBe(true)
	})
})
