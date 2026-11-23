import type { DataAdapter, FileManager, Stat, Vault } from 'obsidian'
import { normalizePath, TAbstractFile, TFile, TFolder } from 'obsidian'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8')

export interface MemoryClock {
	now(): number
	advance(ms: number): number
	set(ms: number): void
}

export function createMemoryClock(initialMs = 1_700_000_000_000): MemoryClock {
	let current = initialMs
	return {
		now: () => current,
		advance: (ms: number) => (current += ms),
		set: (ms: number) => {
			current = ms
		},
	}
}

export interface VaultMutation {
	op: 'write' | 'mkdir' | 'remove' | 'rmdir' | 'rename' | 'trash'
	path: string
	dest?: string
}

export interface MemoryVaultFaults {
	onList?: (path: string) => Error | void
	onStat?: (path: string) => Error | void
	onRead?: (path: string) => Error | void
	onWrite?: (path: string) => Error | void
	onRemove?: (path: string) => Error | void
	onTrash?: (path: string) => Error | void
}

type StoredNode =
	| { kind: 'file'; bytes: Uint8Array; ctime: number; mtime: number }
	| { kind: 'folder'; ctime: number; mtime: number }

const toBytes = (data: string | ArrayBuffer | Uint8Array): Uint8Array =>
	typeof data === 'string'
		? encoder.encode(data)
		: data instanceof Uint8Array
			? new Uint8Array(data)
			: new Uint8Array(data.slice(0))

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
	const copy = new ArrayBuffer(bytes.byteLength)
	new Uint8Array(copy).set(bytes)
	return copy
}

const normalizeRel = (input: string): string => {
	const norm = normalizePath(input)
	return norm === '/' ? '' : norm
}

const parentOf = (rel: string): string => {
	const i = rel.lastIndexOf('/')
	return i === -1 ? '' : rel.slice(0, i)
}

function isHidden(rel: string, configDir: string): boolean {
	if (!rel) return false
	const cfg = normalizeRel(configDir)
	if (cfg && (rel === cfg || rel.startsWith(`${cfg}/`))) return true
	return rel
		.split('/')
		.some((s) => s !== '.' && s !== '..' && s.startsWith('.'))
}

/**
 * In-memory Obsidian `Vault` + `DataAdapter` + `FileManager` shared across
 * unit tests, benchmarks, and deterministic simulation tests.
 */
export class MemoryVault {
	readonly vaultName: string
	readonly configDir: string
	readonly clock: MemoryClock
	readonly mtimeResolutionMs: number
	readonly nodes = new Map<string, StoredNode>()
	readonly mutations: VaultMutation[] = []
	readonly faults: MemoryVaultFaults = {}
	readonly adapter: DataAdapter
	readonly vault: Vault
	readonly fileManager: FileManager
	readonly app: { vault: Vault; fileManager: FileManager }

	constructor(options?: {
		name?: string
		configDir?: string
		clock?: MemoryClock
		mtimeResolutionMs?: number
	}) {
		this.vaultName = options?.name ?? 'MemoryVault'
		this.configDir = options?.configDir ?? '.obsidian'
		this.clock = options?.clock ?? createMemoryClock()
		this.mtimeResolutionMs = options?.mtimeResolutionMs ?? 1
		this.adapter = this.buildAdapter()
		this.vault = this.buildVault()
		this.fileManager = this.buildFileManager()
		this.app = { vault: this.vault, fileManager: this.fileManager }
	}

	private timestamp(): number {
		const raw = this.clock.now()
		return this.mtimeResolutionMs > 1
			? Math.floor(raw / this.mtimeResolutionMs) * this.mtimeResolutionMs
			: raw
	}

	private ensureParents(rel: string, ts: number): void {
		const segments = rel.split('/')
		segments.pop()
		let cur = ''
		for (const seg of segments) {
			cur = cur ? `${cur}/${seg}` : seg
			const existing = this.nodes.get(cur)
			if (existing?.kind === 'file') {
				throw new Error(`ENOTDIR: parent path is a file: ${cur}`)
			}
			if (!existing)
				this.nodes.set(cur, { kind: 'folder', ctime: ts, mtime: ts })
		}
	}

	private writeNode(
		path: string,
		bytes: Uint8Array,
		options?: { ctime?: number; mtime?: number },
		record = true,
	): void {
		const rel = normalizeRel(path)
		if (!rel) throw new Error('Cannot write file at vault root')
		if (record) {
			const fault = this.faults.onWrite?.(rel)
			if (fault) throw fault
		}
		const ts = options?.mtime ?? this.timestamp()
		this.ensureParents(rel, ts)
		const existing = this.nodes.get(rel)
		if (existing?.kind === 'folder') {
			throw new Error(`EISDIR: cannot overwrite folder with file: ${rel}`)
		}
		this.nodes.set(rel, {
			kind: 'file',
			bytes,
			ctime: options?.ctime ?? existing?.ctime ?? ts,
			mtime: ts,
		})
		if (record) this.mutations.push({ op: 'write', path: rel })
	}

	seedFile(
		path: string,
		content: string | ArrayBuffer | Uint8Array,
		mtime?: number,
	): void {
		this.writeNode(
			path,
			toBytes(content),
			mtime === undefined ? undefined : { mtime },
			false,
		)
	}

	seedFolder(path: string, mtime?: number): void {
		const rel = normalizeRel(path)
		if (!rel) return
		const ts = mtime ?? this.timestamp()
		this.ensureParents(rel, ts)
		const existing = this.nodes.get(rel)
		if (existing?.kind === 'file') {
			throw new Error(`EEXIST: cannot seed folder over file: ${rel}`)
		}
		if (!existing) this.nodes.set(rel, { kind: 'folder', ctime: ts, mtime: ts })
	}

	removeDirect(path: string, recursive = true): void {
		const rel = normalizeRel(path)
		const node = this.nodes.get(rel)
		if (!node) return
		if (node.kind === 'folder') {
			const prefix = `${rel}/`
			const children = [...this.nodes.keys()].filter((k) =>
				k.startsWith(prefix),
			)
			if (!recursive && children.length > 0) {
				throw new Error(`ENOTEMPTY: directory not empty: ${rel}`)
			}
			for (const k of children) this.nodes.delete(k)
		}
		this.nodes.delete(rel)
	}

	moveDirect(fromPath: string, toPath: string, preserveMtime = true): void {
		const from = normalizeRel(fromPath)
		const to = normalizeRel(toPath)
		if (from === to) return
		const node = this.nodes.get(from)
		if (!node) throw new Error(`ENOENT: cannot move missing path: ${from}`)
		if (this.nodes.has(to)) throw new Error(`EEXIST: destination exists: ${to}`)
		const ts = this.timestamp()
		this.ensureParents(to, ts)
		if (node.kind === 'file') {
			this.nodes.delete(from)
			this.nodes.set(to, {
				kind: 'file',
				bytes: new Uint8Array(node.bytes),
				ctime: node.ctime,
				mtime: preserveMtime ? node.mtime : ts,
			})
			return
		}
		const prefix = `${from}/`
		const moved: Array<[string, StoredNode]> = [[from, node]]
		for (const entry of this.nodes.entries()) {
			if (entry[0].startsWith(prefix)) moved.push(entry)
		}
		for (const [k] of moved) this.nodes.delete(k)
		for (const [k, v] of moved) {
			this.nodes.set(k === from ? to : `${to}${k.slice(from.length)}`, v)
		}
	}

	readBytesDirect(path: string): Uint8Array | undefined {
		const node = this.nodes.get(normalizeRel(path))
		return node?.kind === 'file' ? new Uint8Array(node.bytes) : undefined
	}

	readTextDirect(path: string): string | undefined {
		const bytes = this.readBytesDirect(path)
		return bytes ? decoder.decode(bytes) : undefined
	}

	snapshotFiles(): Map<string, Uint8Array> {
		const out = new Map<string, Uint8Array>()
		for (const [p, n] of this.nodes) {
			if (n.kind === 'file') out.set(p, new Uint8Array(n.bytes))
		}
		return out
	}

	snapshotFolders(): Set<string> {
		const out = new Set<string>()
		for (const [p, n] of this.nodes) if (n.kind === 'folder') out.add(p)
		return out
	}

	clearMutations(): void {
		this.mutations.length = 0
	}

	private makeTFile(
		rel: string,
		node: Extract<StoredNode, { kind: 'file' }>,
		parent: TFolder | null,
	): TFile {
		const name = rel.split('/').pop() ?? rel
		const dot = name.lastIndexOf('.')
		return Object.assign(new TFile(), {
			path: rel,
			name,
			basename: dot > 0 ? name.slice(0, dot) : name,
			extension: dot > 0 ? name.slice(dot + 1) : '',
			stat: {
				ctime: node.ctime,
				mtime: node.mtime,
				size: node.bytes.byteLength,
			},
			parent,
			vault: this.vault,
		})
	}

	private makeTFolder(rel: string, parent: TFolder | null): TFolder {
		const norm = rel || '/'
		return Object.assign(new TFolder(), {
			path: norm,
			name: norm === '/' ? '' : (norm.split('/').pop() ?? ''),
			parent,
			vault: this.vault,
			children: [] as TAbstractFile[],
		})
	}

	private toTFile(
		rel: string,
		node: Extract<StoredNode, { kind: 'file' }>,
	): TFile {
		return this.makeTFile(
			rel,
			node,
			this.makeTFolder(parentOf(rel) || '/', null),
		)
	}

	private toTFolder(rel: string): TFolder {
		const folder = this.makeTFolder(
			rel || '/',
			rel ? this.makeTFolder(parentOf(rel) || '/', null) : null,
		)
		const prefix = rel ? `${rel}/` : ''
		for (const [path, node] of this.nodes) {
			if (isHidden(path, this.configDir) || !path.startsWith(prefix)) continue
			const rest = path.slice(prefix.length)
			if (!rest || rest.includes('/')) continue
			folder.children.push(
				node.kind === 'file'
					? this.makeTFile(path, node, folder)
					: this.makeTFolder(path, folder),
			)
		}
		return folder
	}

	private buildAdapter(): DataAdapter {
		const readFileNode = (path: string) => {
			const rel = normalizeRel(path)
			const fault = this.faults.onRead?.(rel)
			if (fault) throw fault
			const node = this.nodes.get(rel)
			if (!node) throw new Error(`ENOENT: ${rel}`)
			if (node.kind !== 'file') throw new Error(`EISDIR: ${rel}`)
			return node
		}
		const adapter: Partial<DataAdapter> = {
			getName: () => this.vaultName,
			exists: async (path: string) => {
				const rel = normalizeRel(path)
				return rel === '' || this.nodes.has(rel)
			},
			stat: async (path: string): Promise<Stat | null> => {
				const rel = normalizeRel(path)
				const fault = this.faults.onStat?.(rel || '/')
				if (fault) throw fault
				if (rel === '') return { type: 'folder', ctime: 0, mtime: 0, size: 0 }
				const node = this.nodes.get(rel)
				if (!node) return null
				return {
					type: node.kind,
					ctime: node.ctime,
					mtime: node.mtime,
					size: node.kind === 'file' ? node.bytes.byteLength : 0,
				}
			},
			list: async (path: string) => {
				const rel = normalizeRel(path)
				const fault = this.faults.onList?.(rel || '/')
				if (fault) throw fault
				if (rel !== '') {
					const target = this.nodes.get(rel)
					if (!target) throw new Error(`ENOENT: no such directory: ${rel}`)
					if (target.kind !== 'folder') {
						throw new Error(`ENOTDIR: not a directory: ${rel}`)
					}
				}
				const files: string[] = []
				const folders: string[] = []
				const prefix = rel ? `${rel}/` : ''
				for (const [p, node] of this.nodes) {
					if (!p.startsWith(prefix)) continue
					const rest = p.slice(prefix.length)
					if (!rest || rest.includes('/')) continue
					;(node.kind === 'file' ? files : folders).push(p)
				}
				files.sort()
				folders.sort()
				return { files, folders }
			},
			read: async (path: string) => decoder.decode(readFileNode(path).bytes),
			readBinary: async (path: string) =>
				toArrayBuffer(readFileNode(path).bytes),
			write: async (path: string, data: string, options) => {
				this.writeNode(path, encoder.encode(data), options, true)
			},
			writeBinary: async (path: string, data: ArrayBuffer, options) => {
				this.writeNode(path, toBytes(data), options, true)
			},
			append: async (path: string, data: string, options) => {
				const rel = normalizeRel(path)
				const existing = this.nodes.get(rel)
				const prefix =
					existing?.kind === 'file' ? decoder.decode(existing.bytes) : ''
				this.writeNode(rel, encoder.encode(`${prefix}${data}`), options, true)
			},
			mkdir: async (path: string) => {
				const rel = normalizeRel(path)
				if (!rel) return
				const fault = this.faults.onWrite?.(rel)
				if (fault) throw fault
				const ts = this.timestamp()
				this.ensureParents(rel, ts)
				const existing = this.nodes.get(rel)
				if (existing?.kind === 'file') {
					throw new Error(`EEXIST: cannot mkdir over file: ${rel}`)
				}
				if (!existing) {
					this.nodes.set(rel, { kind: 'folder', ctime: ts, mtime: ts })
					this.mutations.push({ op: 'mkdir', path: rel })
				}
			},
			remove: async (path: string) => {
				const rel = normalizeRel(path)
				const fault = this.faults.onRemove?.(rel)
				if (fault) throw fault
				const node = this.nodes.get(rel)
				if (!node) return
				if (node.kind === 'folder') {
					throw new Error(`EISDIR: cannot remove folder with remove(): ${rel}`)
				}
				this.nodes.delete(rel)
				this.mutations.push({ op: 'remove', path: rel })
			},
			rmdir: async (path: string, recursive: boolean) => {
				const rel = normalizeRel(path)
				const fault = this.faults.onRemove?.(rel)
				if (fault) throw fault
				const node = this.nodes.get(rel)
				if (!node) return
				if (node.kind !== 'folder') throw new Error(`ENOTDIR: ${rel}`)
				this.removeDirect(rel, recursive)
				this.mutations.push({ op: 'rmdir', path: rel })
			},
			rename: async (fromPath: string, toPath: string) => {
				const from = normalizeRel(fromPath)
				const to = normalizeRel(toPath)
				const fault = this.faults.onWrite?.(to) ?? this.faults.onRemove?.(from)
				if (fault) throw fault
				if (!this.nodes.has(from)) throw new Error(`ENOENT: ${from}`)
				if (this.nodes.has(to)) {
					throw new Error(`Destination file already exists!: ${to}`)
				}
				this.moveDirect(from, to, true)
				this.mutations.push({ op: 'rename', path: from, dest: to })
			},
			copy: async (fromPath: string, toPath: string) => {
				const node = readFileNode(fromPath)
				this.writeNode(toPath, new Uint8Array(node.bytes), undefined, true)
			},
			trashLocal: async (path: string) => {
				const rel = normalizeRel(path)
				const fault = this.faults.onTrash?.(rel)
				if (fault) throw fault
				this.removeDirect(rel, true)
				this.mutations.push({ op: 'trash', path: rel })
			},
			trashSystem: async (path: string) => {
				await adapter.trashLocal!(path)
				return true
			},
			getResourcePath: (path: string) =>
				`app://local/${encodeURIComponent(normalizeRel(path))}`,
		}
		return adapter as DataAdapter
	}

	private buildVault(): Vault {
		const vault: Partial<Vault> = {
			configDir: this.configDir,
			adapter: this.adapter,
			getName: () => this.vaultName,
			getRoot: () => this.toTFolder(''),
			getAbstractFileByPath: (path: string): TAbstractFile | null => {
				const rel = normalizeRel(path)
				if (rel === '') return this.toTFolder('')
				if (isHidden(rel, this.configDir)) return null
				const node = this.nodes.get(rel)
				return !node
					? null
					: node.kind === 'file'
						? this.toTFile(rel, node)
						: this.toTFolder(rel)
			},
			getFiles: () =>
				[...this.nodes.entries()]
					.filter(
						(entry): entry is [string, Extract<StoredNode, { kind: 'file' }>] =>
							entry[1].kind === 'file' && !isHidden(entry[0], this.configDir),
					)
					.map(([p, n]) => this.toTFile(p, n)),
			getMarkdownFiles: () =>
				vault.getFiles!().filter((file) => file.extension === 'md'),
			getAllLoadedFiles: () => [
				this.toTFolder(''),
				...[...this.nodes.entries()]
					.filter(([p]) => !isHidden(p, this.configDir))
					.map(([p, n]) =>
						n.kind === 'file' ? this.toTFile(p, n) : this.toTFolder(p),
					),
			],
			read: async (file: TFile) => this.adapter.read(file.path),
			cachedRead: async (file: TFile) => this.adapter.read(file.path),
			readBinary: async (file: TFile) => this.adapter.readBinary(file.path),
			create: async (path: string, data: string, options) => {
				const rel = normalizeRel(path)
				if (this.nodes.has(rel)) throw new Error(`File already exists: ${rel}`)
				await this.adapter.write(rel, data, options)
				return this.toTFile(
					rel,
					this.nodes.get(rel) as Extract<StoredNode, { kind: 'file' }>,
				)
			},
			createBinary: async (path: string, data: ArrayBuffer, options) => {
				const rel = normalizeRel(path)
				if (this.nodes.has(rel)) throw new Error(`File already exists: ${rel}`)
				await this.adapter.writeBinary(rel, data, options)
				return this.toTFile(
					rel,
					this.nodes.get(rel) as Extract<StoredNode, { kind: 'file' }>,
				)
			},
			modify: async (file: TFile, data: string, options) =>
				this.adapter.write(file.path, data, options),
			modifyBinary: async (file: TFile, data: ArrayBuffer, options) =>
				this.adapter.writeBinary(file.path, data, options),
			createFolder: async (path: string) => {
				const rel = normalizeRel(path)
				await this.adapter.mkdir(rel)
				return this.toTFolder(rel)
			},
			delete: async (file: TAbstractFile, force = false) => {
				const rel = normalizeRel(file.path)
				const node = this.nodes.get(rel)
				if (!node) return
				if (node.kind === 'folder') await this.adapter.rmdir(rel, force)
				else await this.adapter.remove(rel)
			},
			trash: async (file: TAbstractFile) => this.adapter.trashLocal(file.path),
			rename: async (file: TAbstractFile, newPath: string) =>
				this.adapter.rename(file.path, newPath),
		}
		return vault as Vault
	}

	private buildFileManager(): FileManager {
		return {
			trashFile: async (file: TAbstractFile) => {
				await this.adapter.trashLocal(file.path)
			},
		} as FileManager
	}
}
