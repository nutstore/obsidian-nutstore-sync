import { describe, expect, it } from 'vitest'
import { TFile, TFolder, type App, type Vault } from 'obsidian'
import type { PermissionRequest } from '~/ai/tools/permission-guard'
import { createVaultBash, execVaultBash, VAULT_MOUNT_POINT } from './runtime'
import {
	listVaultPaths,
	MountedVaultFs,
	ObsidianVaultFs,
	ReversibleOpRecorder,
} from './fs'

interface MockEntryFile {
	type: 'file'
	content: Uint8Array
	mtime: number
}

interface MockEntryFolder {
	type: 'folder'
	mtime: number
}

type MockEntry = MockEntryFile | MockEntryFolder

interface MockAbstractFile {
	path: string
	name: string
	parent: MockFolder | null
}

interface MockFile extends MockAbstractFile {
	stat: {
		size: number
		mtime: number
	}
}

interface MockFolder extends MockAbstractFile {
	children: Array<MockFile | MockFolder>
}

class MemoryVaultStore {
	private readonly entries = new Map<string, MockEntry>([
		['', { type: 'folder', mtime: 0 }],
	])

	constructor(
		initialFiles: Record<string, string> = {},
		initialFolders: string[] = [],
	) {
		for (const folder of initialFolders) {
			this.ensureFolder(folder)
		}
		for (const [path, content] of Object.entries(initialFiles)) {
			this.writeBinary(path, new TextEncoder().encode(content).buffer)
		}
	}

	normalize(path: string) {
		return path.replace(/^\/+|\/+$/g, '')
	}

	dirname(path: string) {
		if (!path || !path.includes('/')) {
			return ''
		}
		return path.slice(0, path.lastIndexOf('/'))
	}

	basename(path: string) {
		if (!path) {
			return ''
		}
		const normalized = this.normalize(path)
		return normalized.slice(normalized.lastIndexOf('/') + 1)
	}

	ensureFolder(path: string) {
		const normalized = this.normalize(path)
		if (!normalized) {
			return
		}
		const parent = this.dirname(normalized)
		if (parent !== normalized) {
			this.ensureFolder(parent)
		}
		if (!this.entries.has(normalized)) {
			this.entries.set(normalized, { type: 'folder', mtime: Date.now() })
		}
	}

	exists(path: string) {
		return this.entries.has(this.normalize(path))
	}

	stat(path: string) {
		const entry = this.entries.get(this.normalize(path))
		if (!entry) {
			return null
		}
		return {
			type: entry.type,
			ctime: entry.mtime,
			mtime: entry.mtime,
			size: entry.type === 'file' ? entry.content.byteLength : 0,
		}
	}

	readBinary(path: string) {
		const entry = this.entries.get(this.normalize(path))
		if (!entry || entry.type !== 'file') {
			throw new Error(`missing file: ${path}`)
		}
		return entry.content.buffer.slice(
			entry.content.byteOffset,
			entry.content.byteOffset + entry.content.byteLength,
		) as ArrayBuffer
	}

	writeBinary(path: string, data: ArrayBuffer) {
		const normalized = this.normalize(path)
		this.ensureFolder(this.dirname(normalized))
		this.entries.set(normalized, {
			type: 'file',
			content: new Uint8Array(data),
			mtime: Date.now(),
		})
	}

	remove(path: string) {
		this.entries.delete(this.normalize(path))
	}

	removeRecursive(path: string) {
		const normalized = this.normalize(path)
		for (const key of [...this.entries.keys()]) {
			if (key === normalized || key.startsWith(`${normalized}/`)) {
				this.entries.delete(key)
			}
		}
	}

	rename(fromPath: string, toPath: string) {
		const from = this.normalize(fromPath)
		const to = this.normalize(toPath)
		this.ensureFolder(this.dirname(to))
		const moved = [...this.entries.entries()]
			.filter(([key]) => key === from || key.startsWith(`${from}/`))
			.sort((left, right) => left[0].length - right[0].length)
		for (const [key, value] of moved) {
			this.entries.delete(key)
			const suffix = key.slice(from.length)
			this.entries.set(
				`${to}${suffix}`,
				value.type === 'folder'
					? { ...value }
					: { ...value, content: value.content.slice() },
			)
		}
	}

	listChildren(path: string) {
		const normalized = this.normalize(path)
		const prefix = normalized ? `${normalized}/` : ''
		return [...this.entries.keys()]
			.filter((key) => key.startsWith(prefix) && key !== normalized)
			.filter((key) => !key.slice(prefix.length).includes('/'))
			.sort()
	}
}

function createMockVault(
	initialFiles: Record<string, string> = {},
	initialFolders: string[] = [],
) {
	const store = new MemoryVaultStore(initialFiles, initialFolders)

	const buildFolder = (path: string, parent: MockFolder | null): MockFolder => {
		const normalized = store.normalize(path)
		const folder: MockFolder = Object.assign(new TFolder(), {
			path: normalized,
			name: normalized ? store.basename(normalized) : '',
			parent,
			children: [],
		})
		folder.children = store.listChildren(normalized).map((childPath) => {
			const childStat = store.stat(childPath)
			if (childStat?.type === 'folder') {
				return buildFolder(childPath, folder)
			}
			return Object.assign(new TFile(), {
				path: childPath,
				name: store.basename(childPath),
				parent: folder,
				stat: {
					size: childStat?.size ?? 0,
					mtime: childStat?.mtime ?? 0,
				},
			}) satisfies MockFile
		})
		return folder
	}

	const root = () => buildFolder('', null)

	const vault = {
		getRoot() {
			return root()
		},
		getAbstractFileByPath(path: string) {
			const normalized = store.normalize(path)
			if (!normalized) {
				return root()
			}
			const stat = store.stat(normalized)
			if (!stat) {
				return null
			}
			const parentPath = store.dirname(normalized)
			const parent =
				parentPath === normalized ? null : buildFolder(parentPath, null)
			if (stat.type === 'folder') {
				return buildFolder(normalized, parent)
			}
			return Object.assign(new TFile(), {
				path: normalized,
				name: store.basename(normalized),
				parent,
				stat: {
					size: stat.size,
					mtime: stat.mtime,
				},
			}) satisfies MockFile
		},
		async readBinary(file: MockFile) {
			return store.readBinary(file.path)
		},
		async createBinary(path: string, data: ArrayBuffer) {
			store.writeBinary(path, data)
			return vault.getAbstractFileByPath(path)
		},
		async cachedRead(file: MockFile) {
			return new TextDecoder().decode(store.readBinary(file.path))
		},
		async modifyBinary(file: MockFile, data: ArrayBuffer) {
			store.writeBinary(file.path, data)
		},
		async modify(file: MockFile, content: string) {
			store.writeBinary(file.path, new TextEncoder().encode(content).buffer)
		},
		async createFolder(path: string) {
			store.ensureFolder(path)
			return vault.getAbstractFileByPath(path)
		},
		async delete(file: MockFile | MockFolder) {
			const stat = store.stat(file.path)
			if (stat?.type === 'folder') {
				store.removeRecursive(file.path)
				return
			}
			store.remove(file.path)
		},
		async trash(file: MockFile | MockFolder) {
			return vault.delete(file as never)
		},
		async rename(file: MockFile | MockFolder, newPath: string) {
			store.rename(file.path, newPath)
		},
		adapter: {
			async exists(path: string) {
				return store.exists(path)
			},
			async stat(path: string) {
				const s = store.stat(path)
				if (!s) return null
				return {
					type: s.type === 'folder' ? ('folder' as const) : ('file' as const),
					mtime: s.mtime,
					size: s.size,
				}
			},
			async readBinary(path: string) {
				return store.readBinary(path)
			},
			async writeBinary(path: string, data: ArrayBuffer) {
				store.writeBinary(path, data)
			},
			async write(path: string, data: string) {
				store.writeBinary(path, new TextEncoder().encode(data).buffer)
			},
			async create(path: string, data: string) {
				store.writeBinary(path, new TextEncoder().encode(data).buffer)
			},
			async createBinary(path: string, data: ArrayBuffer) {
				store.writeBinary(path, data)
			},
			async remove(path: string) {
				store.remove(path)
			},
			async rmdir(path: string, _recursive: boolean) {
				store.removeRecursive(path)
			},
		},
		configDir: '.obsidian',
	} as unknown as Vault

	return {
		vault,
		store,
	}
}

function createApp(vault: Vault) {
	return {
		vault,
	} as unknown as App
}

describe('vault bash runtime', () => {
	it('builds a vault path snapshot for globbing', async () => {
		const { vault } = createMockVault(
			{
				'notes/today.md': 'hello',
			},
			['notes'],
		)
		const app = createApp(vault)

		await expect(listVaultPaths(app)).resolves.toEqual(
			expect.arrayContaining(['/', '/notes', '/notes/today.md']),
		)
	})

	it('mounts the Obsidian vault under /vault and supports writes', async () => {
		const { vault, store } = createMockVault(
			{
				'docs/readme.md': 'hello world\n',
			},
			['docs'],
		)
		const app = createApp(vault)

		const result = await execVaultBash(
			app,
			'cat /vault/docs/readme.md && printf "done" > /vault/docs/output.txt',
		)

		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('hello world')
		expect(new TextDecoder().decode(store.readBinary('docs/output.txt'))).toBe(
			'done',
		)
	})

	it('supports shell glob expansion from the initial vault snapshot', async () => {
		const { vault } = createMockVault(
			{
				'notes/a.md': 'A',
				'notes/b.md': 'B',
			},
			['notes'],
		)
		const bash = await createVaultBash(createApp(vault))

		const result = await bash.exec('printf "%s\n" /vault/notes/*.md')
		expect(result.exitCode).toBe(0)
		expect(result.stdout).toContain('/vault/notes/a.md')
		expect(result.stdout).toContain('/vault/notes/b.md')
	})

	it('exposes /vault as a mount while preserving scratch space outside it', async () => {
		const { vault } = createMockVault(
			{
				'note.md': 'hello',
			},
			[],
		)
		const mounted = new MountedVaultFs(
			new ObsidianVaultFs(vault, ['/', '/note.md']),
		)

		await mounted.writeFile('/scratch.txt', 'temp')
		expect(await mounted.readFile('/scratch.txt')).toBe('temp')
		expect(await mounted.readFile(`${VAULT_MOUNT_POINT}/note.md`)).toBe('hello')
		expect(await mounted.readdir('/')).toEqual(['scratch.txt', 'vault'])
	})

	it('records reversible ops for writes, deletes, copies, and moves', async () => {
		const { vault } = createMockVault(
			{
				'docs/existing.md': 'before',
				'docs/nested/a.txt': 'A',
			},
			['docs', 'docs/nested'],
		)
		const recorder = new ReversibleOpRecorder()
		const fs = new ObsidianVaultFs(
			vault,
			['/', '/docs', '/docs/existing.md', '/docs/nested', '/docs/nested/a.txt'],
			undefined,
			recorder,
		)

		await fs.writeFile('/docs/new.md', 'new')
		await fs.writeFile('/docs/existing.md', 'after')
		await fs.mkdir('/docs/deep/child', { recursive: true })
		await fs.rm('/docs/nested', { recursive: true })
		await fs.cp('/docs', '/docs-copy', { recursive: true })
		await fs.mv('/docs/new.md', '/moved/new.md')

		expect(recorder.getOperations()).toEqual([
			{
				vaultPath: 'docs/new.md',
				operation: 'create',
				before: { kind: 'file' },
			},
			{
				vaultPath: 'docs/existing.md',
				operation: 'update',
				before: expect.objectContaining({
					kind: 'file',
					contentCompressed: {
						compress: 'deflate',
						blob: expect.any(Blob),
					},
				}),
			},
			{
				vaultPath: 'docs/deep/child',
				operation: 'create',
				before: { kind: 'dir' },
			},
			{
				vaultPath: 'docs/nested/a.txt',
				operation: 'delete',
				before: expect.objectContaining({
					kind: 'file',
					contentCompressed: {
						compress: 'deflate',
						blob: expect.any(Blob),
					},
				}),
			},
			{
				vaultPath: 'docs/nested',
				operation: 'delete',
				before: { kind: 'dir' },
			},
			{
				vaultPath: 'docs-copy',
				operation: 'create',
				before: { kind: 'dir' },
			},
			{
				vaultPath: 'docs-copy/deep',
				operation: 'create',
				before: { kind: 'dir' },
			},
			{
				vaultPath: 'docs-copy/deep/child',
				operation: 'create',
				before: { kind: 'dir' },
			},
			{
				vaultPath: 'docs-copy/existing.md',
				operation: 'create',
				before: { kind: 'file' },
			},
			{
				vaultPath: 'docs-copy/new.md',
				operation: 'create',
				before: { kind: 'file' },
			},
			{
				vaultPath: 'moved',
				operation: 'create',
				before: { kind: 'dir' },
			},
			{
				vaultPath: 'docs/new.md',
				operation: 'delete',
				before: expect.objectContaining({
					kind: 'file',
					contentCompressed: {
						compress: 'deflate',
						blob: expect.any(Blob),
					},
				}),
			},
			{
				vaultPath: 'moved/new.md',
				operation: 'create',
				before: { kind: 'file' },
			},
		])
	})

	it('checks cp destination and mv source plus destination in permission guard', async () => {
		const { vault } = createMockVault(
			{
				'docs/source.md': 'source',
			},
			['docs'],
		)
		const requests: PermissionRequest[] = []
		const fs = new ObsidianVaultFs(
			vault,
			['/', '/docs', '/docs/source.md'],
			async (request) => {
				requests.push(request)
			},
		)

		await fs.cp('/docs/source.md', '/docs/copied.md')
		await fs.mv('/docs/copied.md', '/docs/moved.md')

		expect(requests).toEqual([
			{
				type: 'fs',
				fs: {
					kind: 'copy',
					src: '/vault/docs/source.md',
					dest: '/vault/docs/copied.md',
				},
			},
			{
				type: 'fs',
				fs: {
					kind: 'move',
					src: '/vault/docs/copied.md',
					dest: '/vault/docs/moved.md',
				},
			},
		])
	})

	it('records overwritten target content for cp and mv', async () => {
		const { vault } = createMockVault(
			{
				'docs/src-copy.md': 'copy-source',
				'docs/src-move.md': 'move-source',
				'docs/dest-copy.md': 'copy-dest-before',
				'docs/dest-move.md': 'move-dest-before',
			},
			['docs'],
		)
		const recorder = new ReversibleOpRecorder()
		const fs = new ObsidianVaultFs(
			vault,
			[
				'/',
				'/docs',
				'/docs/src-copy.md',
				'/docs/src-move.md',
				'/docs/dest-copy.md',
				'/docs/dest-move.md',
			],
			undefined,
			recorder,
		)

		await fs.cp('/docs/src-copy.md', '/docs/dest-copy.md')
		await fs.mv('/docs/src-move.md', '/docs/dest-move.md')

		expect(recorder.getOperations()).toEqual([
			{
				vaultPath: 'docs/dest-copy.md',
				operation: 'update',
				before: expect.objectContaining({
					kind: 'file',
					contentCompressed: {
						compress: 'deflate',
						blob: expect.any(Blob),
					},
				}),
			},
			{
				vaultPath: 'docs/src-move.md',
				operation: 'delete',
				before: expect.objectContaining({
					kind: 'file',
					contentCompressed: {
						compress: 'deflate',
						blob: expect.any(Blob),
					},
				}),
			},
			{
				vaultPath: 'docs/dest-move.md',
				operation: 'update',
				before: expect.objectContaining({
					kind: 'file',
					contentCompressed: {
						compress: 'deflate',
						blob: expect.any(Blob),
					},
				}),
			},
		])
	})

	describe('onRead callback', () => {
		it('fires onRead with vault-relative path when readFile succeeds', async () => {
			const { vault } = createMockVault({ 'notes/file.md': 'hello' }, ['notes'])
			const reads: string[] = []
			const fs = new ObsidianVaultFs(
				vault,
				['/', '/notes', '/notes/file.md'],
				undefined,
				undefined,
				(path) => reads.push(path),
			)

			const content = await fs.readFile('/notes/file.md')

			expect(content).toBe('hello')
			expect(reads).toEqual(['notes/file.md'])
		})

		it('fires onRead with vault-relative path when readFileBuffer succeeds', async () => {
			const { vault } = createMockVault({ 'notes/file.md': 'hello' }, ['notes'])
			const reads: string[] = []
			const fs = new ObsidianVaultFs(
				vault,
				['/', '/notes', '/notes/file.md'],
				undefined,
				undefined,
				(path) => reads.push(path),
			)

			const buf = await fs.readFileBuffer('/notes/file.md')

			expect(new TextDecoder().decode(buf)).toBe('hello')
			expect(reads).toEqual(['notes/file.md'])
		})

		it('does not fire onRead for stat', async () => {
			const { vault } = createMockVault({ 'notes/file.md': 'hello' }, ['notes'])
			const reads: string[] = []
			const fs = new ObsidianVaultFs(
				vault,
				['/', '/notes', '/notes/file.md'],
				undefined,
				undefined,
				(path) => reads.push(path),
			)

			await fs.stat('/notes/file.md')

			expect(reads).toEqual([])
		})

		it('does not fire onRead for readdir', async () => {
			const { vault } = createMockVault(
				{ 'notes/a.md': 'A', 'notes/b.md': 'B' },
				['notes'],
			)
			const reads: string[] = []
			const fs = new ObsidianVaultFs(
				vault,
				['/', '/notes', '/notes/a.md', '/notes/b.md'],
				undefined,
				undefined,
				(path) => reads.push(path),
			)

			await fs.readdir('/notes')

			expect(reads).toEqual([])
		})

		it('does not fire onRead when reading a non-existent file (ENOENT)', async () => {
			const { vault } = createMockVault({}, [])
			const reads: string[] = []
			const fs = new ObsidianVaultFs(
				vault,
				['/'],
				undefined,
				undefined,
				(path) => reads.push(path),
			)

			await expect(fs.readFile('/missing.md')).rejects.toThrow()
			expect(reads).toEqual([])
		})

		it('does not fire onRead when reading a directory (EISDIR)', async () => {
			const { vault } = createMockVault({ 'notes/file.md': 'hello' }, ['notes'])
			const reads: string[] = []
			const fs = new ObsidianVaultFs(
				vault,
				['/', '/notes', '/notes/file.md'],
				undefined,
				undefined,
				(path) => reads.push(path),
			)

			await expect(fs.readFile('/notes')).rejects.toThrow()
			expect(reads).toEqual([])
		})

		it('fires onRead exactly once for readFile (not double via readFileBuffer)', async () => {
			const { vault } = createMockVault({ 'notes/file.md': 'hello' }, ['notes'])
			const reads: string[] = []
			const fs = new ObsidianVaultFs(
				vault,
				['/', '/notes', '/notes/file.md'],
				undefined,
				undefined,
				(path) => reads.push(path),
			)

			await fs.readFile('/notes/file.md')

			expect(reads).toEqual(['notes/file.md'])
		})

		it('threads onRead through execVaultBash when bash reads a vault file', async () => {
			const { vault } = createMockVault({ 'docs/readme.md': 'hello world\n' }, [
				'docs',
			])
			const app = createApp(vault)
			const reads: string[] = []

			const result = await execVaultBash(app, 'cat /vault/docs/readme.md', {
				onRead: (path) => reads.push(path),
			})

			expect(result.exitCode).toBe(0)
			expect(result.stdout).toContain('hello world')
			expect(reads).toEqual(['docs/readme.md'])
		})

		it('preserves UTF-8 bytes when cat redirects a vault file into another vault file', async () => {
			const { vault, store } = createMockVault(
				{ 'docs/source.md': '中文测试\n' },
				['docs'],
			)
			const app = createApp(vault)

			const result = await execVaultBash(
				app,
				'cat /vault/docs/source.md > /vault/docs/copy.md',
			)

			expect(result.exitCode).toBe(0)
			expect(new TextDecoder().decode(store.readBinary('docs/copy.md'))).toBe(
				'中文测试\n',
			)
		})

		it('does not fire onRead for bash ls on a vault directory', async () => {
			const { vault } = createMockVault(
				{ 'docs/a.md': 'A', 'docs/b.md': 'B' },
				['docs'],
			)
			const app = createApp(vault)
			const reads: string[] = []

			await execVaultBash(app, 'ls /vault/docs', {
				onRead: (path) => reads.push(path),
			})

			expect(reads).toEqual([])
		})

		it('does not fire onRead for appendFile (internal read is not an agent read)', async () => {
			const { vault } = createMockVault({ 'docs/file.md': 'hello' }, ['docs'])
			const reads: string[] = []
			const fs = new ObsidianVaultFs(
				vault,
				['/', '/docs', '/docs/file.md'],
				undefined,
				undefined,
				(path) => reads.push(path),
			)

			await fs.appendFile('/docs/file.md', ' world')

			expect(reads).toEqual([])
		})

		it('does not fire onRead for utimes (internal read is not an agent read)', async () => {
			const { vault } = createMockVault({ 'docs/file.md': 'hello' }, ['docs'])
			const reads: string[] = []
			const fs = new ObsidianVaultFs(
				vault,
				['/', '/docs', '/docs/file.md'],
				undefined,
				undefined,
				(path) => reads.push(path),
			)

			await fs.utimes('/docs/file.md', new Date(), new Date())

			expect(reads).toEqual([])
		})
	})
})
