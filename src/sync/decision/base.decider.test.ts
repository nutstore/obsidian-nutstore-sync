import { describe, expect, it, vi } from 'vitest'
import type { SyncRecord } from '~/storage/sync-record'
import type { NutstoreSync } from '..'
import ConflictResolveTask, {
	ConflictStrategy,
} from '../tasks/conflict-resolve.task'
import TwoWaySyncDecider from './two-way.decider'

vi.mock('obsidian', () => ({
	normalizePath: (path: string) => path,
	TFile: class {},
}))
vi.mock('~/settings', () => ({
	SyncMode: { LOOSE: 'loose', STRICT: 'strict' },
}))

describe('per-run conflict selection', () => {
	it.each(Object.values(ConflictStrategy))(
		'creates conflict tasks using %s rather than the saved default',
		async (strategy) => {
			const stat = {
				path: 'Notes/普通笔记🌱.md',
				basename: '普通笔记🌱.md',
				isDir: false,
				isDeleted: false,
				mtime: 2,
				size: 20,
			}
			const saved = {
				conflictStrategy: ConflictStrategy.NoConflictMerge,
				syncMode: 'strict',
				skipLargeFiles: { maxSize: '' },
				mobileAppDownloadFileChunkSize: '',
			}
			const sync = {
				settings: saved,
				conflictStrategy: strategy,
				remoteFs: { walk: async () => [{ stat, ignored: false }] },
				logger: {
					info: vi.fn(),
					debug: vi.fn(),
					warn: vi.fn(),
					error: vi.fn(),
				},
				vault: { configDir: '.obsidian' },
				webdav: {},
				remoteBaseDir: '/Notes 笔记🌱/',
			} as unknown as NutstoreSync
			const records = {
				getRecords: async () =>
					new Map([
						[
							stat.path,
							{ local: { ...stat, mtime: 1 }, remote: { ...stat, mtime: 1 } },
						],
					]),
			} as unknown as SyncRecord
			const tasks = await new TwoWaySyncDecider(sync, records, [
				{ stat, ignored: false },
			]).decide()
			expect(tasks).toHaveLength(1)
			expect(tasks[0]).toBeInstanceOf(ConflictResolveTask)
			expect((tasks[0] as ConflictResolveTask).options).toMatchObject({
				strategy,
				localPath: stat.path,
			})
			expect(saved.conflictStrategy).toBe(ConflictStrategy.NoConflictMerge)
		},
	)
})
