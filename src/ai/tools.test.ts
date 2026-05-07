import { describe, expect, it } from 'vitest'
import { TFile, TFolder, type App } from 'obsidian'
import { createAITools } from './tools'
import { VAULT_MOUNT_POINT } from './bash/runtime'
import { filterVaultEntries, type SearchPathEntry } from './search-path-filter'

function makeEntries(
	paths: Array<{ path: string; type: SearchPathEntry['type'] }>,
): SearchPathEntry[] {
	return paths
}

function createToolApp() {
	const files = new Map<string, string>([['notes/existing.md', 'old']])
	const folders = new Set<string>(['', 'notes'])
	const normalize = (path: string) => path.replace(/^\/+|\/+$/g, '')
	const dirname = (path: string) =>
		!path || !path.includes('/') ? '' : path.slice(0, path.lastIndexOf('/'))
	const basename = (path: string) => {
		const normalized = normalize(path)
		return normalized.slice(normalized.lastIndexOf('/') + 1)
	}
	const ensureFolder = (path: string) => {
		const normalized = normalize(path)
		if (!normalized) {
			return
		}
		const parent = dirname(normalized)
		if (parent && parent !== normalized) {
			ensureFolder(parent)
		}
		folders.add(normalized)
	}
	const listChildren = (path: string) => {
		const normalized = normalize(path)
		const prefix = normalized ? `${normalized}/` : ''
		return [...new Set([...folders, ...files.keys()])]
			.filter(
				(item) =>
					item.startsWith(prefix) &&
					item !== normalized &&
					!item.slice(prefix.length).includes('/'),
			)
			.sort()
	}
	const buildFolder = (path: string, parent: any): any => {
		const normalized = normalize(path)
		const folder: any = Object.assign(new TFolder(), {
			path: normalized,
			name: normalized ? basename(normalized) : '',
			parent,
			children: [],
		})
		folder.children = listChildren(normalized).map((childPath) => {
			if (folders.has(childPath)) {
				return buildFolder(childPath, folder)
			}
			return Object.assign(new TFile(), {
				path: childPath,
				name: basename(childPath),
				parent: folder,
				stat: {
					size: files.get(childPath)?.length ?? 0,
					mtime: 0,
				},
			})
		})
		return folder
	}
	const getAbstractFileByPath = (path: string): any => {
		const normalized = normalize(path)
		if (!normalized) {
			return buildFolder('', null)
		}
		if (folders.has(normalized)) {
			return buildFolder(normalized, buildFolder(dirname(normalized), null))
		}
		if (files.has(normalized)) {
			return Object.assign(new TFile(), {
				path: normalized,
				name: basename(normalized),
				parent: buildFolder(dirname(normalized), null),
				stat: {
					size: files.get(normalized)?.length ?? 0,
					mtime: 0,
				},
			})
		}
		return null
	}

	return {
		vault: {
			getRoot() {
				return buildFolder('', null)
			},
			getAbstractFileByPath,
			async readBinary(file: any) {
				return new TextEncoder().encode(files.get(normalize(file.path)) ?? '')
					.buffer as ArrayBuffer
			},
			async cachedRead(file: any) {
				return files.get(normalize(file.path)) ?? ''
			},
			async createBinary(path: string, data: ArrayBuffer) {
				const normalized = normalize(path)
				ensureFolder(dirname(normalized))
				files.set(normalized, new TextDecoder().decode(data))
				return getAbstractFileByPath(normalized)
			},
			async modifyBinary(file: any, data: ArrayBuffer) {
				files.set(normalize(file.path), new TextDecoder().decode(data))
			},
			async modify(file: any, content: string) {
				files.set(normalize(file.path), content)
			},
			async createFolder(path: string) {
				ensureFolder(path)
				return getAbstractFileByPath(path)
			},
			async delete(file: any) {
				const normalized = normalize(file.path)
				files.delete(normalized)
				for (const folder of [...folders]) {
					if (folder === normalized || folder.startsWith(`${normalized}/`)) {
						folders.delete(folder)
					}
				}
			},
			async rename(file: any, newPath: string) {
				const from = normalize(file.path)
				const to = normalize(newPath)
				ensureFolder(dirname(to))
				const value = files.get(from)
				if (value !== undefined) {
					files.delete(from)
					files.set(to, value)
					return
				}
				for (const folder of [...folders]) {
					if (folder === from || folder.startsWith(`${from}/`)) {
						folders.delete(folder)
						folders.add(`${to}${folder.slice(from.length)}`)
					}
				}
			},
		},
	} as unknown as App
}

describe('filterVaultEntries', () => {
	it('treats include patterns as strict filters', () => {
		const entries = makeEntries([
			{ path: '2026-03-30.md', type: 'file' },
			{ path: 'NS_Memo/工作任务.md', type: 'file' },
			{ path: 'NS_Memo/人员列表.md', type: 'file' },
			{ path: 'Excel表格.xlsx', type: 'file' },
		])

		const results = filterVaultEntries(entries, {
			basePath: '',
			include: ['*任务*', '*人员*'],
			exclude: [],
			type: 'file',
			defaultMarkdownOnly: false,
		})

		expect(results.map((entry) => entry.path)).toEqual([
			'NS_Memo/工作任务.md',
			'NS_Memo/人员列表.md',
		])
	})

	it('still excludes files under excluded parent folders', () => {
		const entries = makeEntries([
			{ path: 'NS_Memo/private/任务.md', type: 'file' },
			{ path: 'NS_Memo/public/任务.md', type: 'file' },
		])

		const results = filterVaultEntries(entries, {
			basePath: '',
			include: ['*任务*'],
			exclude: ['NS_Memo/private/'],
			type: 'file',
			defaultMarkdownOnly: false,
		})

		expect(results.map((entry) => entry.path)).toEqual([
			'NS_Memo/public/任务.md',
		])
	})

	it('matches folder paths against include patterns when searching folders', () => {
		const entries = makeEntries([
			{ path: '项目', type: 'folder' },
			{ path: '工作台', type: 'folder' },
			{ path: '归档', type: 'folder' },
		])

		const results = filterVaultEntries(entries, {
			basePath: '',
			include: ['*工作*'],
			exclude: [],
			type: 'folder',
			defaultMarkdownOnly: false,
		})

		expect(results.map((entry) => entry.path)).toEqual(['工作台'])
	})

	it('parses string boolean values without JS truthiness coercion', () => {
		const tools = createAITools({} as never)
		const bashTool = tools.find((tool) => tool.name === 'bash')

		expect(
			bashTool?.inputSchema.parse({
				script: 'pwd',
				rawScript: 'false',
			}),
		).toEqual({
			script: 'pwd',
			cwd: VAULT_MOUNT_POINT,
			rawScript: false,
		})
	})

	it('registers bash and executes against /vault', async () => {
		const tools = createAITools(createToolApp())
		const bashTool = tools.find((tool) => tool.name === 'bash')

		expect(bashTool).toBeDefined()

		const result = await bashTool!.execute(
			{
				script: 'printf "new note" > new.md && cat new.md',
				cwd: VAULT_MOUNT_POINT,
				rawScript: false,
			},
			{} as never,
		)

		expect(result).toEqual({
			result: 'new note',
			reversibleOps: [
				{
					vaultPath: 'new.md',
					operation: 'create',
					before: { kind: 'file' },
				},
			],
		})
	})

	it('accepts absolute virtual cwd paths for bash', async () => {
		const tools = createAITools(createToolApp())
		const bashTool = tools.find((tool) => tool.name === 'bash')

		await expect(
			bashTool!.execute(
				{
					script: 'pwd',
					cwd: '/vault',
					rawScript: false,
				},
				{} as never,
			),
		).resolves.toEqual({
			result: '/vault\n',
			reversibleOps: [],
		})
	})

	it('records reversible ops for edit_file replacements', async () => {
		const tools = createAITools(createToolApp())
		const editTool = tools.find((tool) => tool.name === 'edit_file')

		const result = await editTool!.execute(
			{
				path: 'notes/existing.md',
				oldText: 'old',
				newText: 'new',
			},
			{} as never,
		)

		expect(result).toEqual({
			result: {
				path: 'notes/existing.md',
				replaced: true,
				matchCount: 1,
			},
			reversibleOps: [
				{
					vaultPath: 'notes/existing.md',
					operation: 'update',
					before: {
						kind: 'file',
						contentBase64: Buffer.from('old').toString('base64'),
					},
				},
			],
		})
	})
})
