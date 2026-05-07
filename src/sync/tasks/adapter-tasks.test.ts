import { Buffer } from 'buffer'
import { TFile, type Vault } from 'obsidian'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebDAVClient } from 'webdav'

vi.mock('~/utils/get-task-name', () => ({
	default: () => 'task',
}))

import ConflictResolveTask, { ConflictStrategy } from './conflict-resolve.task'
import PullTask from './pull.task'
import PushTask from './push.task'

const syncRecordStub = {} as never

function makeFile(path: string) {
	return Object.assign(new TFile(), {
		path,
		stat: { mtime: 1, size: 1 },
	})
}

function createVault(files = new Map<string, TFile>()) {
	return {
		configDir: '.obsidian',
		getAbstractFileByPath: vi.fn((path: string) => files.get(path) ?? null),
		readBinary: vi.fn(async () => Uint8Array.from([9, 8]).buffer),
		modifyBinary: vi.fn(async () => undefined),
		createBinary: vi.fn(async (path: string) => files.set(path, makeFile(path))),
		modify: vi.fn(async () => undefined),
		create: vi.fn(async (path: string) => files.set(path, makeFile(path))),
		createFolder: vi.fn(async () => undefined),
		adapter: {
			exists: vi.fn(),
			readBinary: vi.fn(),
			writeBinary: vi.fn(),
			write: vi.fn(),
			mkdir: vi.fn(),
		},
	} as unknown as Vault & {
		configDir: string
		getAbstractFileByPath: ReturnType<typeof vi.fn>
		readBinary: ReturnType<typeof vi.fn>
		modifyBinary: ReturnType<typeof vi.fn>
		createBinary: ReturnType<typeof vi.fn>
		modify: ReturnType<typeof vi.fn>
		create: ReturnType<typeof vi.fn>
		createFolder: ReturnType<typeof vi.fn>
		adapter: {
			exists: ReturnType<typeof vi.fn>
			readBinary: ReturnType<typeof vi.fn>
			writeBinary: ReturnType<typeof vi.fn>
			write: ReturnType<typeof vi.fn>
			mkdir: ReturnType<typeof vi.fn>
		}
	}
}

function createWebdav() {
	return {
		getFileContents: vi.fn(),
		putFileContents: vi.fn(),
	} as unknown as WebDAVClient & {
		getFileContents: ReturnType<typeof vi.fn>
		putFileContents: ReturnType<typeof vi.fn>
	}
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('PullTask', () => {
	it('writes normal downloaded content through the Vault API after mkdirs', async () => {
		const vault = createVault()
		const webdav = createWebdav()
		const remoteBuffer = Uint8Array.from([1, 2, 3]).buffer
		webdav.getFileContents.mockResolvedValue(remoteBuffer)

		const task = new PullTask({
			vault,
			webdav,
			remoteBaseDir: '/remote',
			remotePath: 'folder/file.bin',
			localPath: 'folder/file.bin',
			syncRecord: syncRecordStub,
			remoteSize: 3,
		})

		await expect(task.exec()).resolves.toEqual({ success: true })
		expect(vault.createFolder).toHaveBeenCalledWith('folder')
		expect(vault.createBinary).toHaveBeenCalledWith(
			'folder/file.bin',
			remoteBuffer,
		)
		expect(vault.adapter.writeBinary).not.toHaveBeenCalled()
	})

	it('writes hidden downloaded content through adapter.writeBinary', async () => {
		const vault = createVault()
		vault.adapter.exists.mockResolvedValue(false)
		const webdav = createWebdav()
		const remoteBuffer = Uint8Array.from([1, 2, 3]).buffer
		webdav.getFileContents.mockResolvedValue(remoteBuffer)

		const task = new PullTask({
			vault,
			webdav,
			remoteBaseDir: '/remote',
			remotePath: '.hidden/file.bin',
			localPath: '.hidden/file.bin',
			syncRecord: syncRecordStub,
			remoteSize: 3,
		})

		await expect(task.exec()).resolves.toEqual({ success: true })
		expect(vault.adapter.mkdir).toHaveBeenCalledWith('.hidden')
		expect(vault.adapter.writeBinary).toHaveBeenCalledWith(
			'.hidden/file.bin',
			remoteBuffer,
		)
		expect(vault.createBinary).not.toHaveBeenCalled()
	})
})

describe('PushTask', () => {
	it('reads normal local content through the Vault API before uploading', async () => {
		const vault = createVault(new Map([['file.bin', makeFile('file.bin')]]))
		const localBuffer = Uint8Array.from([9, 8]).buffer
		vault.readBinary.mockResolvedValue(localBuffer)
		const webdav = createWebdav()
		webdav.putFileContents.mockResolvedValue(true)

		const task = new PushTask({
			vault,
			webdav,
			remoteBaseDir: '/remote',
			remotePath: 'file.bin',
			localPath: 'file.bin',
			syncRecord: syncRecordStub,
		})

		await expect(task.exec()).resolves.toEqual({ success: true })
		expect(vault.readBinary).toHaveBeenCalledWith(expect.any(TFile))
		expect(vault.adapter.readBinary).not.toHaveBeenCalled()
		expect(webdav.putFileContents).toHaveBeenCalledWith(
			'/remote/file.bin',
			localBuffer,
			{
				overwrite: true,
			},
		)
	})

	it('reads hidden local content through adapter before uploading', async () => {
		const vault = createVault()
		const localBuffer = Uint8Array.from([9, 8]).buffer
		vault.adapter.exists.mockResolvedValue(true)
		vault.adapter.readBinary.mockResolvedValue(localBuffer)
		const webdav = createWebdav()
		webdav.putFileContents.mockResolvedValue(true)

		const task = new PushTask({
			vault,
			webdav,
			remoteBaseDir: '/remote',
			remotePath: '.hidden/file.bin',
			localPath: '.hidden/file.bin',
			syncRecord: syncRecordStub,
		})

		await expect(task.exec()).resolves.toEqual({ success: true })
		expect(vault.adapter.readBinary).toHaveBeenCalledWith('.hidden/file.bin')
		expect(vault.readBinary).not.toHaveBeenCalled()
	})
})

describe('ConflictResolveTask', () => {
	it('uses Vault modifyBinary when latest timestamp chooses remote content for a normal path', async () => {
		const vault = createVault(new Map([['note.md', makeFile('note.md')]]))
		vault.readBinary.mockResolvedValue(Buffer.from('local').buffer)
		const webdav = createWebdav()
		const remoteContent = Buffer.from('remote')
		webdav.getFileContents.mockResolvedValue(remoteContent)

		const task = new ConflictResolveTask({
			vault,
			webdav,
			remoteBaseDir: '/remote',
			remotePath: 'note.md',
			localPath: 'note.md',
			syncRecord: syncRecordStub,
			strategy: ConflictStrategy.LatestTimeStamp,
			useGitStyle: false,
			localStat: {
				path: 'note.md',
				basename: 'note.md',
				isDir: false,
				isDeleted: false,
				mtime: 1,
				size: 5,
			},
			remoteStat: {
				path: 'note.md',
				basename: 'note.md',
				isDir: false,
				isDeleted: false,
				mtime: 2,
				size: 6,
			},
		})

		await expect(task.exec()).resolves.toEqual({ success: true })
		expect(vault.modifyBinary).toHaveBeenCalledTimes(1)
		expect(vault.adapter.writeBinary).not.toHaveBeenCalled()
	})

	it('uses adapter.writeBinary when latest timestamp chooses remote content for a hidden path', async () => {
		const vault = createVault()
		vault.adapter.exists.mockResolvedValue(true)
		vault.adapter.readBinary.mockResolvedValue(Buffer.from('local').buffer)
		const webdav = createWebdav()
		const remoteContent = Buffer.from('remote')
		webdav.getFileContents.mockResolvedValue(remoteContent)

		const task = new ConflictResolveTask({
			vault,
			webdav,
			remoteBaseDir: '/remote',
			remotePath: '.hidden/note.md',
			localPath: '.hidden/note.md',
			syncRecord: syncRecordStub,
			strategy: ConflictStrategy.LatestTimeStamp,
			useGitStyle: false,
			localStat: {
				path: '.hidden/note.md',
				basename: 'note.md',
				isDir: false,
				isDeleted: false,
				mtime: 1,
				size: 5,
			},
			remoteStat: {
				path: '.hidden/note.md',
				basename: 'note.md',
				isDir: false,
				isDeleted: false,
				mtime: 2,
				size: 6,
			},
		})

		await expect(task.exec()).resolves.toEqual({ success: true })
		expect(vault.adapter.writeBinary).toHaveBeenCalledTimes(1)
		expect(vault.adapter.writeBinary.mock.calls[0]?.[0]).toBe('.hidden/note.md')
	})

	it('uses Vault modify for merged text updates on a normal path', async () => {
		const vault = createVault(new Map([['note.md', makeFile('note.md')]]))
		vault.readBinary.mockResolvedValue(Buffer.from('hello world').buffer)
		const webdav = createWebdav()
		webdav.getFileContents.mockResolvedValue(Buffer.from('hello brave world'))
		webdav.putFileContents.mockResolvedValue(true)

		const task = new ConflictResolveTask({
			vault,
			webdav,
			remoteBaseDir: '/remote',
			remotePath: 'note.md',
			localPath: 'note.md',
			syncRecord: syncRecordStub,
			strategy: ConflictStrategy.DiffMatchPatch,
			useGitStyle: false,
			record: {
				local: {
					path: 'note.md',
					basename: 'note.md',
					isDir: false,
					isDeleted: false,
					mtime: 1,
					size: 11,
				},
				remote: {
					path: 'note.md',
					basename: 'note.md',
					isDir: false,
					isDeleted: false,
					mtime: 2,
					size: 17,
				},
			},
			localStat: {
				path: 'note.md',
				basename: 'note.md',
				isDir: false,
				isDeleted: false,
				mtime: 1,
				size: 11,
			},
			remoteStat: {
				path: 'note.md',
				basename: 'note.md',
				isDir: false,
				isDeleted: false,
				mtime: 2,
				size: 17,
			},
		})

		await expect(task.exec()).resolves.toEqual({ success: true })
		expect(vault.modify).toHaveBeenCalledTimes(1)
		expect(vault.adapter.write).not.toHaveBeenCalled()
	})
})
