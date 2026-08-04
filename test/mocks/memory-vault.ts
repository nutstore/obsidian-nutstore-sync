import type { Vault } from 'obsidian'

interface MemoryEntry {
	type: 'file' | 'folder'
	content?: string
	mtime: number
}

export interface MemoryVaultHandle {
	vault: Vault
	files: Map<string, MemoryEntry>
}

function normalize(path: string) {
	return path
		.replace(/[\\/]+/g, '/')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
}

function dirname(path: string) {
	const index = path.lastIndexOf('/')
	return index === -1 ? '' : path.slice(0, index)
}

/**
 * Minimal in-memory Vault+DataAdapter double good enough for the chat session
 * file backend: dot-path files are managed purely through the adapter, so only
 * the adapter surface (exists/stat/read/write/rename/remove/list/mkdir) plus
 * `configDir` are exercised. Useful for non-IndexedDB storage tests.
 */
export function createMemoryVault(
	initialFiles: Record<string, string> = {},
	initialFolders: string[] = [],
): MemoryVaultHandle {
	const files = new Map<string, MemoryEntry>()
	const now = () => Date.now()
	for (const [path, content] of Object.entries(initialFiles)) {
		files.set(normalize(path), { type: 'file', content, mtime: now() })
	}
	for (const path of initialFolders) {
		files.set(normalize(path), { type: 'folder', mtime: now() })
	}

	const ensureParents = (path: string) => {
		const parent = dirname(path)
		if (parent && !files.has(parent)) {
			files.set(parent, { type: 'folder', mtime: now() })
		}
		if (parent) {
			ensureParents(parent)
		}
	}

	const list = (path: string) => {
		const normalized = normalize(path)
		const prefix = normalized ? `${normalized}/` : ''
		const children = [...files.keys()].filter(
			(key) => key.startsWith(prefix) && key !== normalized,
		)
		return {
			files: children.filter((key) => files.get(key)?.type === 'file'),
			folders: children.filter((key) => files.get(key)?.type === 'folder'),
		}
	}

	const adapter = {
		async exists(path: string) {
			return files.has(normalize(path))
		},
		async stat(path: string) {
			const entry = files.get(normalize(path))
			if (!entry) return null
			return {
				type: entry.type,
				mtime: entry.mtime,
				size: entry.content?.length ?? 0,
			}
		},
		async read(path: string) {
			const entry = files.get(normalize(path))
			if (!entry || entry.type !== 'file') {
				throw new Error(`Missing file: ${path}`)
			}
			return entry.content ?? ''
		},
		async write(path: string, data: string) {
			const normalized = normalize(path)
			ensureParents(normalized)
			files.set(normalized, { type: 'file', content: data, mtime: now() })
		},
		async rename(fromPath: string, toPath: string) {
			const from = normalize(fromPath)
			const to = normalize(toPath)
			const entry = files.get(from)
			if (!entry) {
				throw new Error(`Missing file to rename: ${fromPath}`)
			}
			ensureParents(to)
			files.delete(to)
			files.set(to, { ...entry, mtime: now() })
			files.delete(from)
		},
		async remove(path: string) {
			files.delete(normalize(path))
		},
		async rmdir(path: string, _recursive: boolean) {
			const normalized = normalize(path)
			for (const key of [...files.keys()]) {
				if (key === normalized || key.startsWith(`${normalized}/`)) {
					files.delete(key)
				}
			}
		},
		async mkdir(path: string) {
			ensureParents(normalize(path))
			files.set(normalize(path), { type: 'folder', mtime: now() })
		},
		list,
	}

	const vault = {
		configDir: '.obsidian',
		adapter,
	} as unknown as Vault

	return { vault, files }
}
