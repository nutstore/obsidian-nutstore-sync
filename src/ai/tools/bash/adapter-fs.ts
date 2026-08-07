import { posix as pathPosix } from 'path-browserify'
import type { DataAdapter } from 'obsidian'
import { normalizePath } from 'obsidian'
import type {
	BufferEncoding,
	CpOptions,
	FileContent,
	FsStat,
	IFileSystem,
	MkdirOptions,
	RmOptions,
} from 'just-bash/browser'
import type { PermissionGuard } from '~/ai/tools/permission-guard'
import { createCompressedFileContent } from '~/ai/chat/messages/reversible-content'
import { sha256Base64 } from '~/utils/sha256'
import {
	decodeContent,
	encodeContent,
	ReversibleOpRecorder,
	toArrayBuffer,
} from './fs'

const FILE_MODE = 0o644
const DIR_MODE = 0o755
type ReadFileOptions = { encoding?: BufferEncoding | null }
type WriteFileOptions = { encoding?: BufferEncoding }

interface AdapterSnapshot {
	path: string
	kind: 'file' | 'dir'
	contentHash?: string
	contentCompressed?: {
		compress: 'deflate'
		blob: Blob
	}
}

function normalizeVirtualPath(path: string) {
	return pathPosix.normalize(pathPosix.resolve('/', path))
}

function joinVirtualPath(parent: string, name: string) {
	return parent === '/' ? `/${name}` : `${parent}/${name}`
}

export class ObsidianAdapterFs implements IFileSystem {
	private readonly paths = new Set<string>(['/'])
	private batchDepth = 0

	private constructor(
		private readonly adapter: DataAdapter,
		private readonly adapterRoot: string,
		private readonly permissionGuard?: PermissionGuard,
		private readonly recorder?: ReversibleOpRecorder,
		private readonly onRead?: (vaultPath: string) => void,
		private readonly permissionMountPoint?: string,
	) {}

	static async create(
		adapter: DataAdapter,
		adapterRoot: string,
		permissionGuard?: PermissionGuard,
		recorder?: ReversibleOpRecorder,
		onRead?: (vaultPath: string) => void,
		permissionMountPoint?: string,
	) {
		const fs = new ObsidianAdapterFs(
			adapter,
			normalizePath(adapterRoot),
			permissionGuard,
			recorder,
			onRead,
			permissionMountPoint,
		)
		await fs.refreshPaths()
		return fs
	}

	private async withBatch<T>(fn: () => Promise<T>): Promise<T> {
		this.batchDepth++
		try {
			return await fn()
		} finally {
			this.batchDepth--
		}
	}

	private async checkPermission(
		request:
			| { kind: 'write' | 'mkdir' | 'delete'; path: string }
			| { kind: 'copy' | 'move'; src: string; dest: string },
	) {
		if (this.batchDepth > 0 || !this.permissionGuard) return
		if ('src' in request) {
			await this.permissionGuard({
				type: 'fs',
				fs: {
					kind: request.kind,
					src: this.toPermissionPath(request.src),
					dest: this.toPermissionPath(request.dest),
				},
			})
			return
		}
		await this.permissionGuard({
			type: 'fs',
			fs: {
				kind: request.kind,
				path: this.toPermissionPath(request.path),
			},
		})
	}

	private toAdapterPath(path: string) {
		const normalized = normalizeVirtualPath(path)
		const suffix = normalized === '/' ? '' : normalized.slice(1)
		return normalizePath(
			suffix ? `${this.adapterRoot}/${suffix}` : this.adapterRoot,
		)
	}

	private toVaultPath(path: string) {
		const normalized = normalizeVirtualPath(path)
		return normalized === '/'
			? this.adapterRoot
			: `${this.adapterRoot}${normalized}`
	}

	private toPermissionPath(path: string) {
		if (this.permissionMountPoint) {
			const normalized = normalizeVirtualPath(path)
			return normalized === '/'
				? this.permissionMountPoint
				: `${this.permissionMountPoint}${normalized}`
		}
		return `/vault/${this.toVaultPath(path)}`
	}

	private toVirtualPath(adapterPath: string) {
		const normalized = normalizePath(adapterPath)
		if (normalized === this.adapterRoot) return '/'
		return `/${normalized.slice(this.adapterRoot.length + 1)}`
	}

	private recordPath(path: string) {
		const normalized = normalizeVirtualPath(path)
		const parts = normalized.split('/').filter(Boolean)
		let current = ''
		for (const part of parts) {
			current += `/${part}`
			this.paths.add(current)
		}
	}

	private forgetPath(path: string) {
		const normalized = normalizeVirtualPath(path)
		for (const item of [...this.paths]) {
			if (item === normalized || item.startsWith(`${normalized}/`)) {
				this.paths.delete(item)
			}
		}
		this.paths.add('/')
	}

	private async refreshPaths() {
		this.paths.clear()
		this.paths.add('/')
		if (!(await this.adapter.exists(this.adapterRoot))) return
		const queue = [this.adapterRoot]
		while (queue.length > 0) {
			const current = queue.shift()!
			const listed = await this.adapter.list(current)
			for (const file of listed.files) {
				this.recordPath(this.toVirtualPath(file))
			}
			for (const folder of listed.folders) {
				this.recordPath(this.toVirtualPath(folder))
				queue.push(normalizePath(folder))
			}
		}
	}

	private async snapshot(path: string): Promise<AdapterSnapshot[]> {
		if (!(await this.exists(path))) return []
		const stat = await this.stat(path)
		if (stat.isDirectory) {
			const snapshots: AdapterSnapshot[] = []
			for (const child of await this.readdir(path)) {
				snapshots.push(...(await this.snapshot(joinVirtualPath(path, child))))
			}
			snapshots.push({ path, kind: 'dir' })
			return snapshots
		}
		const content = new Uint8Array(
			await this.adapter.readBinary(this.toAdapterPath(path)),
		)
		const [contentHash, contentCompressed] = await Promise.all([
			sha256Base64(toArrayBuffer(content)),
			createCompressedFileContent(content),
		])
		return [{ path, kind: 'file', contentHash, contentCompressed }]
	}

	private recordDeletes(snapshots: AdapterSnapshot[]) {
		for (const snapshot of snapshots) {
			this.recorder?.recordDelete(
				snapshot.kind === 'dir'
					? { path: this.toVaultPath(snapshot.path), kind: 'dir' }
					: {
							path: this.toVaultPath(snapshot.path),
							kind: 'file',
							contentHash: snapshot.contentHash!,
							contentCompressed: snapshot.contentCompressed!,
						},
			)
		}
	}

	async readFile(
		path: string,
		options?: ReadFileOptions | BufferEncoding,
	): Promise<string> {
		return decodeContent(await this.readFileBuffer(path), options)
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const result = await this.readInternal(path)
		this.onRead?.(this.toVaultPath(path))
		return result
	}

	private async readInternal(path: string): Promise<Uint8Array> {
		const stat = await this.stat(path)
		if (!stat.isFile) {
			throw new Error(
				`EISDIR: illegal operation on a directory, read '${path}'`,
			)
		}
		return new Uint8Array(
			await this.adapter.readBinary(this.toAdapterPath(path)),
		)
	}

	async writeFile(
		path: string,
		content: FileContent,
		options?: WriteFileOptions | BufferEncoding,
	): Promise<void> {
		await this.checkPermission({ kind: 'write', path })
		await this.withBatch(async () => {
			await this.mkdir(pathPosix.dirname(normalizeVirtualPath(path)), {
				recursive: true,
			})
			const before = await this.snapshot(path)
			const encoded = encodeContent(content, options)
			await this.adapter.writeBinary(
				this.toAdapterPath(path),
				toArrayBuffer(encoded),
			)
			if (before[0]?.kind === 'file') {
				this.recorder?.recordUpdate(this.toVaultPath(path), {
					path: this.toVaultPath(path),
					kind: 'file',
					contentHash: before[0].contentHash!,
					contentCompressed: before[0].contentCompressed!,
				})
			} else {
				this.recorder?.recordCreate(this.toVaultPath(path), 'file')
			}
			this.recordPath(path)
		})
	}

	async appendFile(
		path: string,
		content: FileContent,
		options?: WriteFileOptions | BufferEncoding,
	): Promise<void> {
		const existing = (await this.exists(path))
			? await this.readInternal(path)
			: new Uint8Array()
		const appended = encodeContent(content, options)
		const merged = new Uint8Array(existing.length + appended.length)
		merged.set(existing)
		merged.set(appended, existing.length)
		await this.writeFile(path, merged)
	}

	async exists(path: string): Promise<boolean> {
		return this.adapter.exists(this.toAdapterPath(path))
	}

	async stat(path: string): Promise<FsStat> {
		const stat = await this.adapter.stat(this.toAdapterPath(path))
		if (!stat) {
			throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
		}
		return {
			isFile: stat.type === 'file',
			isDirectory: stat.type === 'folder',
			isSymbolicLink: false,
			mode: stat.type === 'folder' ? DIR_MODE : FILE_MODE,
			size: stat.type === 'folder' ? 0 : stat.size,
			mtime: new Date(stat.mtime),
		}
	}

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		const normalized = normalizeVirtualPath(path)
		if (normalized === '/') {
			if (!(await this.adapter.exists(this.adapterRoot))) {
				await this.adapter.mkdir(this.adapterRoot)
			}
			return
		}
		await this.checkPermission({ kind: 'mkdir', path })
		if (await this.exists(normalized)) {
			if (options?.recursive) return
			throw new Error(`EEXIST: file already exists, mkdir '${path}'`)
		}
		const parent = pathPosix.dirname(normalized)
		if (!(await this.exists(parent))) {
			if (!options?.recursive) {
				throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`)
			}
			await this.withBatch(() => this.mkdir(parent, { recursive: true }))
		}
		await this.adapter.mkdir(this.toAdapterPath(normalized))
		this.recorder?.recordCreate(this.toVaultPath(normalized), 'dir')
		this.recordPath(normalized)
	}

	async readdir(path: string): Promise<string[]> {
		const stat = await this.stat(path)
		if (!stat.isDirectory) {
			throw new Error(`ENOTDIR: not a directory, scandir '${path}'`)
		}
		const listed = await this.adapter.list(this.toAdapterPath(path))
		return [...listed.files, ...listed.folders]
			.map((item) => pathPosix.basename(normalizePath(item)))
			.sort()
	}

	async readdirWithFileTypes(path: string) {
		const listed = await this.adapter.list(this.toAdapterPath(path))
		return [
			...listed.files.map((item) => ({
				name: pathPosix.basename(normalizePath(item)),
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false,
			})),
			...listed.folders.map((item) => ({
				name: pathPosix.basename(normalizePath(item)),
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
			})),
		].sort((left, right) => left.name.localeCompare(right.name))
	}

	async rm(path: string, options?: RmOptions): Promise<void> {
		const normalized = normalizeVirtualPath(path)
		if (normalized === '/') {
			throw new Error(`EPERM: operation not permitted, remove '${path}'`)
		}
		await this.checkPermission({ kind: 'delete', path })
		if (!(await this.exists(normalized))) {
			if (options?.force) return
			throw new Error(`ENOENT: no such file or directory, remove '${path}'`)
		}
		const before = await this.snapshot(normalized)
		const stat = await this.stat(normalized)
		if (stat.isDirectory) {
			if (!options?.recursive && (await this.readdir(normalized)).length > 0) {
				throw new Error(`ENOTEMPTY: directory not empty, remove '${path}'`)
			}
			await this.adapter.rmdir(this.toAdapterPath(normalized), true)
		} else {
			await this.adapter.remove(this.toAdapterPath(normalized))
		}
		this.recordDeletes(before)
		this.forgetPath(normalized)
	}

	async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
		await this.checkPermission({ kind: 'copy', src, dest })
		await this.withBatch(async () => {
			const stat = await this.stat(src)
			if (stat.isDirectory) {
				if (!options?.recursive) {
					throw new Error(`EISDIR: is a directory, copy '${src}'`)
				}
				await this.mkdir(dest, { recursive: true })
				for (const child of await this.readdir(src)) {
					await this.cp(
						joinVirtualPath(src, child),
						joinVirtualPath(dest, child),
						options,
					)
				}
				return
			}
			await this.writeFile(dest, await this.readFileBuffer(src))
		})
	}

	async mv(src: string, dest: string): Promise<void> {
		await this.checkPermission({ kind: 'move', src, dest })
		await this.withBatch(async () => {
			await this.cp(src, dest, { recursive: true })
			await this.rm(src, { recursive: true })
		})
	}

	resolvePath(base: string, path: string): string {
		return normalizeVirtualPath(pathPosix.resolve(base || '/', path))
	}

	getAllPaths(): string[] {
		return [...this.paths].sort()
	}

	async chmod(path: string, _mode: number): Promise<void> {
		await this.stat(path)
	}

	async symlink(_target: string, linkPath: string): Promise<void> {
		throw new Error(
			`ENOTSUP: symbolic links are not supported in adapter fs, link '${linkPath}'`,
		)
	}

	async link(_existingPath: string, newPath: string): Promise<void> {
		throw new Error(
			`ENOTSUP: hard links are not supported in adapter fs, link '${newPath}'`,
		)
	}

	async readlink(path: string): Promise<string> {
		throw new Error(`EINVAL: not a symbolic link, readlink '${path}'`)
	}

	async lstat(path: string): Promise<FsStat> {
		return this.stat(path)
	}

	async realpath(path: string): Promise<string> {
		await this.stat(path)
		return normalizeVirtualPath(path)
	}

	async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
		const content = await this.readInternal(path)
		await this.checkPermission({ kind: 'write', path })
		await this.adapter.writeBinary(
			this.toAdapterPath(path),
			toArrayBuffer(content),
			{
				mtime: mtime.getTime(),
			},
		)
	}
}
