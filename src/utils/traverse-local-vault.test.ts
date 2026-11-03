import { describe, expect, it, vi } from 'vitest'
import type { Stat, Vault } from 'obsidian'
import { SyncScope } from '~/sync/scope'
import { traverseLocalVault } from './traverse-local-vault'

vi.mock('obsidian', () => ({
	normalizePath: (path: string) => path,
	TFile: class {},
	TFolder: class {},
}))

function fixture(folder: string, file: string) {
	const list = vi.fn(async (path: string) =>
		path === '/'
			? { files: [], folders: [folder] }
			: { files: [file], folders: [] },
	)
	const stat = vi.fn(async (path: string): Promise<Stat | null> => ({
		type: path === folder ? 'folder' : 'file',
		mtime: 1,
		ctime: 1,
		size: 8,
	}))
	const vault = {
		configDir: '.obsidian',
		getAbstractFileByPath: () => null,
		adapter: { list, stat },
	} as unknown as Vault
	return { vault, list, stat }
}

describe.each([
	['Notes', 'Notes/Example.md'],
	['笔记', '笔记/示例.md'],
	['记录🌱', '记录🌱/Note 笔记🌱.md'],
])('complete local scanning: %s', (folder, file) => {
	it('reads adapter metadata even when the vault index is empty', async () => {
		const f = fixture(folder, file)
		const snapshot = await traverseLocalVault(f.vault, '/')
		expect(snapshot.entries.map((s) => s.path)).toEqual([folder, file])
	})

	it('isolates a subtree when a nested listing fails', async () => {
		const f = fixture(folder, file)
		const cause = new Error('Folder unavailable')
		f.list.mockImplementation(async (path) => {
			if (path === folder) throw cause
			return { files: [], folders: [folder] }
		})
		const scope = new SyncScope()
		const snapshot = await traverseLocalVault(f.vault, '/', scope)

		expect(snapshot.entries).toEqual([])
		expect(snapshot.issues).toEqual([
			{
				path: folder,
				operation: 'list',
				cause,
			},
		])
	})

	it.each(['folder', 'file'])(
		'isolates missing %s metadata and scans afresh on a later attempt',
		async (kind) => {
			const f = fixture(folder, file)
			const readStat = f.stat.getMockImplementation()!
			f.stat.mockImplementation(async (path) =>
				path === (kind === 'folder' ? folder : file) ? null : readStat(path),
			)
			expect((await traverseLocalVault(f.vault, '/')).issues).toEqual([
				expect.objectContaining({
					path: kind === 'folder' ? folder : file,
					operation: 'stat',
				}),
			])
			f.stat.mockImplementation(readStat)
			const snapshot = await traverseLocalVault(f.vault, '/')
			expect(snapshot.entries.map((s) => s.path)).toEqual([folder, file])
		},
	)

	it('preserves metadata errors as diagnostics', async () => {
		const f = fixture(folder, file)
		const cause = new Error('Metadata unavailable')
		f.stat.mockRejectedValueOnce(cause)
		expect((await traverseLocalVault(f.vault, '/')).issues[0]).toMatchObject({
			cause,
		})
	})

	it('preserves cancellation without reporting a scan failure', async () => {
		const f = fixture(folder, file)
		const cause = new DOMException('Module disabled', 'AbortError')
		f.list.mockRejectedValueOnce(cause)
		await expect(traverseLocalVault(f.vault, '/')).rejects.toBe(cause)
	})

	it('accepts a successfully scanned empty vault', async () => {
		const f = fixture(folder, file)
		f.list.mockResolvedValue({ files: [], folders: [] })
		await expect(traverseLocalVault(f.vault, '/')).resolves.toEqual({
			entries: [],
			issues: [],
		})
	})
	it('ignores inaccessible excluded directories', async () => {
		const f = fixture(folder, file)
		f.stat.mockRejectedValue(new Error('Excluded path unavailable'))
		f.list.mockImplementation(async (path) => {
			if (path !== '/') throw new Error('Excluded path unavailable')
			return { files: [], folders: [folder] }
		})
		const scope = new SyncScope([
			{
				expr: `/${folder}/`,
				type: 'exclude',
				options: { caseSensitive: false },
			},
		])
		expect(await traverseLocalVault(f.vault, '/', scope)).toEqual({
			entries: [],
			issues: [],
		})
	})

	it('still aborts when the root listing fails', async () => {
		const f = fixture(folder, file)
		f.list.mockRejectedValueOnce(new Error('Root unavailable'))
		await expect(traverseLocalVault(f.vault, '/')).rejects.toMatchObject({
			name: 'LocalScanError',
		})
	})
})
