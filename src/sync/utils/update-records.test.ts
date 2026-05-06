import { describe, expect, it, vi } from 'vitest'
import { TFile, type Vault } from 'obsidian'

vi.mock('~/utils/get-task-name', () => ({
	default: () => 'task',
}))

import { updateMtimeInRecord } from './update-records'

const { records, setRecords, getRecords, walk, blobStoreStore } = vi.hoisted(
	() => {
		const records = new Map<string, unknown>()
		return {
			records,
			setRecords: vi.fn(async () => undefined),
			getRecords: vi.fn(async () => records),
			walk: vi.fn(async () => [
				{
					stat: {
						path: 'folder/file.md',
						basename: 'file.md',
						isDir: false,
						isDeleted: false,
						mtime: 20,
						size: 10,
					},
					ignored: false,
				},
			]),
			blobStoreStore: vi.fn(async () => ({
				key: 'blob-key',
				value: undefined,
			})),
		}
	},
)

vi.mock('~/storage/sync-record', () => {
	return {
		SyncRecord: vi.fn().mockImplementation(() => ({
			getRecords,
			setRecords,
		})),
	}
})

vi.mock('~/fs/nutstore', () => {
	return {
		NutstoreFileSystem: vi.fn().mockImplementation(() => ({
			walk,
		})),
	}
})

vi.mock('~/storage/blob', () => {
	return {
		blobStore: {
			store: blobStoreStore,
		},
	}
})

vi.mock('~/events', () => {
	return {
		emitSyncUpdateMtimeProgress: vi.fn(),
	}
})

vi.mock('~/storage', () => {
	return {
		syncRecordKV: {},
	}
})

describe('updateMtimeInRecord', () => {
	it('uses Vault metadata and readBinary for normal paths when persisting records', async () => {
		records.clear()
		setRecords.mockClear()
		getRecords.mockClear()
		walk.mockClear()
		blobStoreStore.mockClear()

		const vault = {
			getName: vi.fn(() => 'vault-name'),
			getAbstractFileByPath: vi.fn((path: string) => {
				if (path !== 'folder/file.md') {
					return null
				}
				return Object.assign(new TFile(), {
					path,
					stat: {
						mtime: 10,
						size: 10,
					},
				})
			}),
			readBinary: vi.fn(async () => Uint8Array.from([1, 2, 3]).buffer),
			configDir: '.obsidian',
			adapter: {
				stat: vi.fn(),
				readBinary: vi.fn(async () => Uint8Array.from([1, 2, 3]).buffer),
			},
		} as unknown as Vault & {
			getAbstractFileByPath: ReturnType<typeof vi.fn>
			readBinary: ReturnType<typeof vi.fn>
			configDir: string
			adapter: {
				stat: ReturnType<typeof vi.fn>
				readBinary: ReturnType<typeof vi.fn>
			}
			getName: ReturnType<typeof vi.fn>
		}

		const task = {
			localPath: 'folder/file.md',
			toJSON: () => ({ localPath: 'folder/file.md' }),
		}

		await updateMtimeInRecord(
			{
				getToken: vi.fn(async () => 'token'),
			} as never,
			vault,
			'/remote',
			[task as never],
			[{ success: true }],
			10,
		)

		expect(vault.adapter.stat).not.toHaveBeenCalled()
		expect(vault.readBinary).toHaveBeenCalledWith(expect.any(TFile))
		expect(vault.adapter.readBinary).not.toHaveBeenCalled()
		expect(blobStoreStore).toHaveBeenCalledTimes(1)
		expect(records.get('folder/file.md')).toEqual({
			local: {
				path: 'folder/file.md',
				basename: 'file.md',
				isDir: false,
				isDeleted: false,
				mtime: 10,
				size: 10,
			},
			remote: {
				path: 'folder/file.md',
				basename: 'file.md',
				isDir: false,
				isDeleted: false,
				mtime: 20,
				size: 10,
			},
			base: {
				key: 'blob-key',
			},
		})
		expect(setRecords).toHaveBeenCalled()
	})
})
