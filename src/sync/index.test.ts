import { beforeEach, describe, expect, it, vi } from 'vitest'

const { deciderTasks, showProgressModalMock, updateMtimeInRecordMock } =
	vi.hoisted(() => ({
		deciderTasks: [] as unknown[],
		showProgressModalMock: vi.fn(),
		updateMtimeInRecordMock: vi.fn(async () => undefined),
	}))

vi.mock('./decision/two-way.decider', () => ({
	default: vi.fn().mockImplementation(() => ({
		decide: vi.fn(async () => deciderTasks),
	})),
}))

vi.mock('~/fs/nutstore', () => ({
	NutstoreFileSystem: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('~/fs/local-vault', () => ({
	LocalVaultFileSystem: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('~/storage', () => ({
	syncRecordKV: {
		get: vi.fn(async () => new Map()),
		set: vi.fn(async () => undefined),
		unset: vi.fn(async () => undefined),
	},
}))

vi.mock('./utils/update-records', () => ({
	updateMtimeInRecord: updateMtimeInRecordMock,
}))

vi.mock('~/utils/config-dir-rules', () => ({
	computeEffectiveFilterRules: vi.fn(() => undefined),
}))

vi.mock('~/utils/logger', () => ({
	default: {
		debug: vi.fn(),
		error: vi.fn(),
	},
}))

vi.mock('~/utils/get-task-name', () => ({
	default: vi.fn(() => 'test task'),
}))

import { onSyncProgress, UpdateSyncProgress } from '~/events'
import { NutstoreSync, SyncStartMode } from './index'

function createSync() {
	const plugin = {
		app: {
			vault: {
				getName: vi.fn(() => 'vault'),
			},
		},
		remoteBaseDir: '/remote',
		settings: {
			confirmBeforeSync: false,
			confirmBeforeDeleteInAutoSync: false,
		},
		progressService: {
			showProgressModal: showProgressModalMock,
		},
	} as any
	const webdav = {
		exists: vi.fn(async () => true),
		createDirectory: vi.fn(async () => undefined),
	}

	return new NutstoreSync(plugin, {
		vault: plugin.app.vault,
		token: 'token',
		remoteBaseDir: '/remote',
		webdav: webdav as any,
	})
}

function createTask() {
	return {
		options: {
			localPath: 'note.md',
		},
		localPath: 'note.md',
		exec: vi.fn(() => ({ success: true })),
	}
}

describe('NutstoreSync.start', () => {
	beforeEach(() => {
		deciderTasks.length = 0
		showProgressModalMock.mockClear()
		updateMtimeInRecordMock.mockClear()
	})

	it('does not open the progress modal for a manual sync with no tasks', async () => {
		const sync = createSync()

		await expect(
			sync.start({ mode: SyncStartMode.MANUAL_SYNC }),
		).resolves.toBe(false)

		expect(showProgressModalMock).not.toHaveBeenCalled()
	})

	it('opens the progress modal for a manual sync with a substantial task', async () => {
		deciderTasks.push(createTask())
		const sync = createSync()

		await expect(
			sync.start({ mode: SyncStartMode.MANUAL_SYNC }),
		).resolves.toBe(true)

		expect(showProgressModalMock).toHaveBeenCalledTimes(1)
		expect(updateMtimeInRecordMock).toHaveBeenCalledTimes(1)
	})

	it('emits the initial total progress before opening the progress modal', async () => {
		deciderTasks.push(createTask())
		const sync = createSync()
		const progressEvents: UpdateSyncProgress[] = []
		const subscription = onSyncProgress().subscribe((progress) => {
			progressEvents.push(progress)
		})
		showProgressModalMock.mockImplementationOnce(() => {
			expect(progressEvents).toHaveLength(1)
			expect(progressEvents[0]).toMatchObject({
				total: 1,
				completed: [],
			})
		})

		try {
			await expect(
				sync.start({ mode: SyncStartMode.MANUAL_SYNC }),
			).resolves.toBe(true)
		} finally {
			subscription.unsubscribe()
		}

		expect(progressEvents).toHaveLength(2)
		expect(progressEvents[1].total).toBe(1)
		expect(progressEvents[1].completed).toHaveLength(1)
	})
})
