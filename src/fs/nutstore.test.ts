import type { Vault } from 'obsidian'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NutstoreSettings } from '~/settings'
import { NutstoreFileSystem } from './nutstore'

const traversal = vi.hoisted(() => ({
	traverse: vi.fn(),
}))

vi.mock('~/utils/get-db-key', () => ({
	getTraversalWebDAVDBKey: vi.fn(async () => 'traversal-key'),
}))

vi.mock('~/utils/traverse-webdav', () => ({
	ResumableWebDAVTraversal: class {
		traverse = traversal.traverse
	},
}))

function createFileSystem(remoteBaseDir = '/vault/') {
	return new NutstoreFileSystem({
		vault: { configDir: '.obsidian' } as Vault,
		settings: {} as NutstoreSettings,
		token: 'token',
		remoteBaseDir,
		filterRules: {
			exclusionRules: [],
			inclusionRules: [],
		},
	})
}

describe('NutstoreFileSystem.walk path projection', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('keeps trailing-slash directories, filters outside paths, and does not mutate traversal data', async () => {
		const source = [
			{
				path: '/vault/',
				basename: 'vault',
				isDir: true,
				isDeleted: false,
			},
			{
				path: '/vault/folder/',
				basename: 'folder',
				isDir: true,
				isDeleted: false,
			},
			{
				path: '/vault/folder/note.md',
				basename: 'note.md',
				isDir: false,
				isDeleted: false,
				mtime: 1,
				size: 10,
			},
			{
				path: '/vault-other/outside.md',
				basename: 'outside.md',
				isDir: false,
				isDeleted: false,
				mtime: 1,
				size: 10,
			},
		]
		const originalPaths = source.map((stat) => stat.path)
		traversal.traverse.mockResolvedValue(source)

		const result = await createFileSystem().walk()

		expect(result.map(({ stat }) => stat.path)).toEqual([
			'folder',
			'folder/note.md',
		])
		expect(source.map((stat) => stat.path)).toEqual(originalPaths)
	})

	it('projects legacy relative traversal paths under the configured base', async () => {
		traversal.traverse.mockResolvedValue([
			{
				path: 'legacy.md',
				basename: 'legacy.md',
				isDir: false,
				isDeleted: false,
				mtime: 1,
				size: 10,
			},
		])

		const result = await createFileSystem('/vault').walk()

		expect(result[0]?.stat.path).toBe('legacy.md')
	})
})
