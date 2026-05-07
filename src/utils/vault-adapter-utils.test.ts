import { describe, expect, it, vi } from 'vitest'
import { TFile, TFolder, type Vault } from 'obsidian'
import { mkdirsVault } from './mkdirs-vault'
import { statVaultItem } from './stat-vault-item'
import { traverseLocalVault } from './traverse-local-vault'

type AdapterMock = {
	stat: ReturnType<typeof vi.fn>
	exists: ReturnType<typeof vi.fn>
	list: ReturnType<typeof vi.fn>
	mkdir: ReturnType<typeof vi.fn>
}

type VaultMock = Vault & {
	adapter: AdapterMock
	configDir: string
	getAbstractFileByPath: ReturnType<typeof vi.fn>
	createFolder: ReturnType<typeof vi.fn>
}

function makeFile(path: string, mtime: number, size: number) {
	return Object.assign(new TFile(), {
		path,
		stat: { mtime, size },
	})
}

function makeFolder(path: string) {
	return Object.assign(new TFolder(), { path })
}

function createVault(
	adapterOverrides: Partial<AdapterMock> = {},
	abstractFiles = new Map<string, TFile | TFolder>(),
) {
	const adapter: AdapterMock = {
		stat: vi.fn(),
		exists: vi.fn(),
		list: vi.fn(),
		mkdir: vi.fn(),
		...adapterOverrides,
	}

	return {
		adapter,
		configDir: '.obsidian',
		getAbstractFileByPath: vi.fn((path: string) => abstractFiles.get(path) ?? null),
		createFolder: vi.fn(async (path: string) => {
			abstractFiles.set(path, makeFolder(path))
		}),
	} as unknown as VaultMock
}

describe('statVaultItem', () => {
	it('reads normal file metadata from the Vault API', async () => {
		const vault = createVault(
			{
				stat: vi.fn(),
			},
			new Map([['folder/note.md', makeFile('folder/note.md', 123, 456)]]),
		)

		await expect(statVaultItem(vault, 'folder/note.md')).resolves.toEqual({
			path: 'folder/note.md',
			basename: 'note.md',
			isDir: false,
			isDeleted: false,
			mtime: 123,
			size: 456,
		})
		expect(vault.adapter.stat).not.toHaveBeenCalled()
	})

	it('reads hidden file metadata from adapter.stat', async () => {
		const vault = createVault({
			stat: vi.fn().mockResolvedValue({
				type: 'file',
				mtime: 123,
				size: 456,
			}),
		})

		await expect(statVaultItem(vault, '.hidden/note.md')).resolves.toEqual({
			path: '.hidden/note.md',
			basename: 'note.md',
			isDir: false,
			isDeleted: false,
			mtime: 123,
			size: 456,
		})
		expect(vault.adapter.stat).toHaveBeenCalledWith('.hidden/note.md')
	})

	it('returns undefined when the path is missing', async () => {
		const vault = createVault()

		await expect(statVaultItem(vault, 'missing.md')).resolves.toBeUndefined()
	})
})

describe('mkdirsVault', () => {
	it('creates missing parent directories from top to bottom', async () => {
		const mkdir = vi.fn(async (path: string) => {
			return path
		})
		const vault = createVault({ mkdir }, new Map())

		await mkdirsVault(vault, 'a/b/c')

		expect(vault.createFolder.mock.calls.map(([path]) => path)).toEqual([
			'a',
			'a/b',
			'a/b/c',
		])
		expect(mkdir).not.toHaveBeenCalled()
	})

	it('skips work for root-like paths and existing directories', async () => {
		const mkdir = vi.fn()
		const vault = createVault({ mkdir }, new Map([['exists', makeFolder('exists')]]))

		await mkdirsVault(vault, '.')
		await mkdirsVault(vault, '/')
		await mkdirsVault(vault, 'exists')

		expect(mkdir).not.toHaveBeenCalled()
	})
})

describe('traverseLocalVault', () => {
	it('walks adapter.list recursively and ignores config node_modules', async () => {
		const abstractFiles = new Map<string, TFile | TFolder>([
			['docs', makeFolder('docs')],
			['readme.md', makeFile('readme.md', 2, 3)],
			['docs/file.md', makeFile('docs/file.md', 2, 3)],
		])
		const vault = createVault({
			stat: vi.fn(async (path: string) => {
				const folders = new Set([
					'.obsidian',
					'.obsidian/plugins',
					'.obsidian/plugins/test',
					'.obsidian/plugins/test/node_modules',
				])
				if (folders.has(path)) {
					return { type: 'folder', mtime: 1, size: 0 }
				}
				if (path === 'readme.md' || path === 'docs/file.md') {
					return { type: 'file', mtime: 2, size: 3 }
				}
				if (path === '.obsidian/plugins/test/node_modules/dep.js') {
					return { type: 'file', mtime: 4, size: 5 }
				}
				return null
			}),
			list: vi.fn(async (path: string) => {
				if (path === '') {
					return {
						files: ['readme.md'],
						folders: ['docs', '.obsidian'],
					}
				}
				if (path === 'docs') {
					return {
						files: ['docs/file.md'],
						folders: [],
					}
				}
				if (path === '.obsidian') {
					return {
						files: [],
						folders: ['.obsidian/plugins'],
					}
				}
				if (path === '.obsidian/plugins') {
					return {
						files: [],
						folders: ['.obsidian/plugins/test'],
					}
				}
				if (path === '.obsidian/plugins/test') {
					return {
						files: [],
						folders: ['.obsidian/plugins/test/node_modules'],
					}
				}
				if (path === '.obsidian/plugins/test/node_modules') {
					return {
						files: ['.obsidian/plugins/test/node_modules/dep.js'],
						folders: [],
					}
				}
				return { files: [], folders: [] }
			}),
		}, abstractFiles)

		const results = await traverseLocalVault(vault, '')

		expect(results.map((item) => item.path)).toEqual([
			'readme.md',
			'docs',
			'.obsidian',
			'docs/file.md',
			'.obsidian/plugins',
			'.obsidian/plugins/test',
		])
		expect(vault.adapter.stat).not.toHaveBeenCalledWith('readme.md')
		expect(vault.adapter.stat).not.toHaveBeenCalledWith('docs')
		expect(vault.adapter.stat).toHaveBeenCalledWith('.obsidian')
	})

	it('returns an empty array when the start path is not a folder', async () => {
		const vault = createVault({
			list: vi.fn(async () => {
				throw new Error('missing')
			}),
		})

		await expect(traverseLocalVault(vault, 'missing')).resolves.toEqual([])
		expect(vault.adapter.list).toHaveBeenCalledWith('missing')
	})
})
