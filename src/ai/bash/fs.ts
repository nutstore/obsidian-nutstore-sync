import { fromUint8Array } from 'js-base64'
import {
	InMemoryFs,
	type BufferEncoding,
	type CpOptions,
	type FileContent,
	type FsStat,
	type IFileSystem,
	type MkdirOptions,
	type RmOptions,
} from 'just-bash/browser'
import {
	normalizePath,
	TFile,
	TFolder,
	type App,
	type TAbstractFile,
	type Vault,
} from 'obsidian'
import { posix as pathPosix } from 'path-browserify'
import type {
	AIDualPathFileOperation,
	AISinglePathFileOperation,
} from '~/ai/file-operation'
import type { PermissionGuard } from '~/ai/permission-guard'
import { cloneReversibleToolOp, type ReversibleToolOp } from '~/chat/domain'
import { createCompressedFileContent } from '~/chat/reversible-content'
import { sha256Base64 } from '~/utils/sha256'

const FILE_MODE = 0o644
const DIR_MODE = 0o755
const VAULT_MOUNT_POINT = '/vault'
type ReadFileOptions = { encoding?: BufferEncoding | null }
type WriteFileOptions = { encoding?: BufferEncoding }
type SnapshotKind = 'file' | 'dir'
type VaultSnapshotNode =
	| {
			path: string
			kind: 'dir'
	  }
	| {
			path: string
			kind: 'file'
			contentHash: string
			contentCompressed: {
				compress: 'deflate'
				blob: Blob
			}
	  }

function getEncoding(
	options?: ReadFileOptions | WriteFileOptions | BufferEncoding | null,
) {
	if (!options) {
		return 'utf8'
	}
	return typeof options === 'string' ? options : (options.encoding ?? 'utf8')
}

function decodeContent(
	content: Uint8Array,
	options?: ReadFileOptions | BufferEncoding,
) {
	const encoding = getEncoding(options)
	if (encoding === 'base64') {
		return fromUint8Array(content, false)
	}
	return new TextDecoder('utf-8').decode(content)
}

function encodeContent(
	content: FileContent,
	options?: WriteFileOptions | BufferEncoding,
) {
	if (content instanceof Uint8Array) {
		return content
	}

	const encoding = getEncoding(options)
	if (encoding === 'base64') {
		if (typeof Buffer !== 'undefined') {
			return Uint8Array.from(Buffer.from(content, 'base64'))
		}
		const decoded = atob(content)
		return Uint8Array.from(decoded, (char) => char.charCodeAt(0))
	}

	return new TextEncoder().encode(content)
}

function toArrayBuffer(content: Uint8Array) {
	return content.buffer.slice(
		content.byteOffset,
		content.byteOffset + content.byteLength,
	) as ArrayBuffer
}

function getPathDepth(path: string) {
	return path.split('/').filter(Boolean).length
}

function normalizeVirtualPath(inputPath: string) {
	const normalized = pathPosix.normalize(pathPosix.resolve('/', inputPath))
	return normalized === '' ? '/' : normalized
}

function joinVirtualPath(parent: string, name: string) {
	return parent === '/' ? `/${name}` : `${parent}/${name}`
}

function ensureNotEscapingRoot(inputPath: string) {
	const normalized = normalizeVirtualPath(inputPath)
	if (!normalized.startsWith('/')) {
		throw new Error(`EINVAL: invalid path '${inputPath}'`)
	}
	return normalized
}

function normalizeReversibleVaultPath(path: string) {
	const normalized = ensureNotEscapingRoot(path)
	if (normalized === '/') {
		return ''
	}
	return normalizePath(normalized.slice(1))
}

function mapStat(stat: {
	type: 'file' | 'folder'
	size: number
	mtime: number
}): FsStat {
	return {
		isFile: stat.type === 'file',
		isDirectory: stat.type === 'folder',
		isSymbolicLink: false,
		mode: stat.type === 'folder' ? DIR_MODE : FILE_MODE,
		size: stat.type === 'file' ? stat.size : 0,
		mtime: new Date(stat.mtime),
	}
}

function mapAbstractFileStat(file: TAbstractFile): FsStat {
	if (file instanceof TFolder) {
		return mapStat({
			type: 'folder',
			size: 0,
			mtime: 0,
		})
	}

	return mapStat({
		type: 'file',
		size: (file as TFile).stat.size,
		mtime: (file as TFile).stat.mtime,
	})
}

async function copyRecursive(
	fs: IFileSystem,
	src: string,
	dest: string,
	options?: CpOptions,
) {
	const sourceStat = await fs.stat(src)
	if (sourceStat.isDirectory) {
		if (!options?.recursive) {
			throw new Error(`EISDIR: illegal operation on a directory, copy '${src}'`)
		}
		await fs.mkdir(dest, { recursive: true })
		for (const entry of await fs.readdir(src)) {
			await copyRecursive(
				fs,
				joinVirtualPath(src, entry),
				joinVirtualPath(dest, entry),
				options,
			)
		}
		return
	}

	const content = await fs.readFileBuffer(src)
	await fs.writeFile(dest, content)
}

async function removeRecursive(
	fs: IFileSystem,
	targetPath: string,
	options?: RmOptions,
) {
	const stat = await fs.stat(targetPath)
	if (stat.isDirectory) {
		const children = await fs.readdir(targetPath)
		if (children.length > 0 && !options?.recursive) {
			throw new Error(`ENOTEMPTY: directory not empty, remove '${targetPath}'`)
		}
		for (const child of children) {
			await removeRecursive(fs, joinVirtualPath(targetPath, child), options)
		}
	}
	await fs.rm(targetPath, options)
}

export async function listVaultPaths(app: App) {
	const paths = new Set<string>(['/'])
	const queue = [...app.vault.getRoot().children]

	while (queue.length > 0) {
		const current = queue.shift()
		if (!current) {
			continue
		}

		paths.add(`/${normalizePath(current.path)}`)
		if (current instanceof TFolder) {
			queue.push(...current.children)
		}
	}

	return [...paths]
}

export class ReversibleOpRecorder {
	private readonly operations: ReversibleToolOp[] = []

	recordCreate(vaultPath: string, kind: SnapshotKind) {
		const normalizedPath = normalizeReversibleVaultPath(vaultPath)
		if (!normalizedPath) {
			return
		}
		this.operations.push({
			vaultPath: normalizedPath,
			operation: 'create',
			before: { kind },
		})
	}

	recordUpdate(
		vaultPath: string,
		content: Extract<VaultSnapshotNode, { kind: 'file' }>,
	) {
		const normalizedPath = normalizeReversibleVaultPath(vaultPath)
		if (!normalizedPath) {
			return
		}
		this.operations.push({
			vaultPath: normalizedPath,
			operation: 'update',
			before: {
				kind: 'file',
				contentCompressed: content.contentCompressed,
			},
		})
	}

	recordDelete(snapshot: VaultSnapshotNode) {
		const normalizedPath = normalizeReversibleVaultPath(snapshot.path)
		if (!normalizedPath) {
			return
		}
		this.operations.push({
			vaultPath: normalizedPath,
			operation: 'delete',
			before:
				snapshot.kind === 'dir'
					? { kind: 'dir' }
					: {
							kind: 'file',
							contentCompressed: snapshot.contentCompressed,
						},
		})
	}

	getOperations(): ReversibleToolOp[] {
		return this.operations.map(cloneReversibleToolOp)
	}
}

export class ObsidianVaultFs implements IFileSystem {
	private readonly snapshot = new Set<string>()
	private _batchDepth = 0

	constructor(
		private readonly vault: Vault,
		initialPaths: string[] = [],
		private readonly permissionGuard?: PermissionGuard,
		private readonly recorder?: ReversibleOpRecorder,
	) {
		for (const path of initialPaths) {
			this.snapshot.add(ensureNotEscapingRoot(path))
		}
		this.snapshot.add('/')
	}

	private async withBatch<T>(fn: () => Promise<T>): Promise<T> {
		this._batchDepth++
		try {
			return await fn()
		} finally {
			this._batchDepth--
		}
	}

	private async checkPermission(
		request:
			| { kind: AISinglePathFileOperation; path: string }
			| { kind: AIDualPathFileOperation; src: string; dest: string },
	): Promise<void> {
		if (this._batchDepth > 0 || !this.permissionGuard) return
		const normalizedRequest =
			'src' in request
				? {
						type: 'fs' as const,
						fs: {
							kind: request.kind,
							src: this.toPermissionPath(request.src),
							dest: this.toPermissionPath(request.dest),
						},
					}
				: {
						type: 'fs' as const,
						fs: {
							kind: request.kind,
							path: this.toPermissionPath(request.path),
						},
					}
		await this.permissionGuard({
			...normalizedRequest,
		})
	}

	private toPermissionPath(path: string) {
		const normalized = ensureNotEscapingRoot(path)
		return normalized === '/'
			? VAULT_MOUNT_POINT
			: `${VAULT_MOUNT_POINT}${normalized}`
	}

	private toVaultPath(inputPath: string) {
		const normalized = ensureNotEscapingRoot(inputPath)
		return normalized === '/' ? '' : normalizePath(normalized.slice(1))
	}

	private async statInternal(inputPath: string) {
		const target = this.vault.getAbstractFileByPath(this.toVaultPath(inputPath))
		if (!target) {
			throw new Error(`ENOENT: no such file or directory, stat '${inputPath}'`)
		}
		return target
	}

	private async readFileSnapshotContent(target: TFile) {
		const content = new Uint8Array(
			(await this.vault.readBinary(target as never)) as ArrayBuffer,
		)
		const [contentHash, contentCompressed] = await Promise.all([
			sha256Base64(toArrayBuffer(content)),
			createCompressedFileContent(content),
		])
		return { contentHash, contentCompressed }
	}

	private async snapshotNode(
		target:
			| TAbstractFile
			| { path: string; name: string; children?: unknown[] },
		virtualPath: string,
	): Promise<VaultSnapshotNode[]> {
		if (target instanceof TFolder) {
			const children = [...target.children].sort((left, right) =>
				left.path.localeCompare(right.path),
			)
			const snapshots: VaultSnapshotNode[] = []
			for (const child of children) {
				snapshots.push(
					...(await this.snapshotNode(
						child,
						joinVirtualPath(virtualPath, child.name),
					)),
				)
			}
			snapshots.push({ path: virtualPath, kind: 'dir' })
			return snapshots
		}

		return [
			{
				path: virtualPath,
				kind: 'file',
				...(await this.readFileSnapshotContent(target as TFile)),
			},
		]
	}

	private async snapshotSubtree(path: string) {
		const normalized = ensureNotEscapingRoot(path)
		const target = this.vault.getAbstractFileByPath(
			this.toVaultPath(normalized),
		)
		if (!target) {
			return []
		}
		return this.snapshotNode(target, normalized)
	}

	private toSnapshotMap(entries: VaultSnapshotNode[]) {
		return new Map(entries.map((entry) => [entry.path, entry]))
	}

	private recordDeleteSnapshots(entries: VaultSnapshotNode[]) {
		if (!this.recorder) {
			return
		}
		for (const entry of entries) {
			this.recorder.recordDelete(entry)
		}
	}

	private recordTargetDiff(
		beforeEntries: VaultSnapshotNode[],
		afterEntries: VaultSnapshotNode[],
	) {
		if (!this.recorder) {
			return
		}
		const beforeByPath = this.toSnapshotMap(beforeEntries)
		const afterByPath = this.toSnapshotMap(afterEntries)

		for (const entry of afterEntries.sort((left, right) => {
			const depthDelta = getPathDepth(left.path) - getPathDepth(right.path)
			return depthDelta !== 0 ? depthDelta : left.path.localeCompare(right.path)
		})) {
			const previous = beforeByPath.get(entry.path)
			if (!previous) {
				this.recorder.recordCreate(entry.path, entry.kind)
				continue
			}
			if (previous.kind !== entry.kind) {
				this.recorder.recordDelete(previous)
				this.recorder.recordCreate(entry.path, entry.kind)
				continue
			}
			if (
				entry.kind === 'file' &&
				previous.kind === 'file' &&
				previous.contentHash !== entry.contentHash
			) {
				this.recorder.recordUpdate(entry.path, previous)
			}
		}

		for (const entry of beforeEntries
			.filter((entry) => !afterByPath.has(entry.path))
			.sort((left, right) => {
				const depthDelta = getPathDepth(right.path) - getPathDepth(left.path)
				return depthDelta !== 0
					? depthDelta
					: left.path.localeCompare(right.path)
			})) {
			this.recorder.recordDelete(entry)
		}
	}

	private async deleteAbstractFile(target: TAbstractFile) {
		if (typeof this.vault.trash === 'function') {
			await this.vault.trash(target, false)
			return
		}
		if (typeof this.vault.delete === 'function') {
			await this.vault.delete(target, false)
			return
		}
		throw new Error(
			`ENOTSUP: vault delete is not available for '${target.path}'`,
		)
	}

	private recordPath(inputPath: string) {
		const normalized = ensureNotEscapingRoot(inputPath)
		const parts = normalized.split('/').filter(Boolean)
		this.snapshot.add('/')
		let current = ''
		for (const part of parts) {
			current = `${current}/${part}`
			this.snapshot.add(current)
		}
	}

	private forgetPath(inputPath: string) {
		const normalized = ensureNotEscapingRoot(inputPath)
		for (const path of [...this.snapshot]) {
			if (path === normalized || path.startsWith(`${normalized}/`)) {
				this.snapshot.delete(path)
			}
		}
		this.snapshot.add('/')
	}

	private assertExists(path: string) {
		return this.exists(path).then((exists) => {
			if (!exists) {
				throw new Error(`ENOENT: no such file or directory, access '${path}'`)
			}
		})
	}

	async readFile(
		path: string,
		options?: ReadFileOptions | BufferEncoding,
	): Promise<string> {
		return this.withBatch(() =>
			this.readFileBuffer(path).then((buf) => decodeContent(buf, options)),
		)
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const stat = await this.stat(path)
		if (!stat.isFile) {
			throw new Error(
				`EISDIR: illegal operation on a directory, read '${path}'`,
			)
		}
		const target = this.vault.getAbstractFileByPath(this.toVaultPath(path))
		if (!(target instanceof TFile)) {
			throw new Error(`ENOENT: no such file or directory, read '${path}'`)
		}
		const buffer = await this.vault.readBinary(target as never)
		return new Uint8Array(buffer as ArrayBuffer)
	}

	async writeFile(
		path: string,
		content: FileContent,
		options?: WriteFileOptions | BufferEncoding,
	): Promise<void> {
		await this.checkPermission({ kind: 'write', path })
		await this.withBatch(async () => {
			await this.mkdir(pathPosix.dirname(ensureNotEscapingRoot(path)), {
				recursive: true,
			})
			const encoded = encodeContent(content, options)
			const vaultPath = this.toVaultPath(path)
			const target = this.vault.getAbstractFileByPath(vaultPath)
			if (target) {
				if (!(target instanceof TFile)) {
					throw new Error(
						`EISDIR: illegal operation on a directory, write '${path}'`,
					)
				}
				this.recorder?.recordUpdate(path, {
					path,
					kind: 'file',
					...(await this.readFileSnapshotContent(target)),
				})
				await this.vault.modifyBinary(target as never, toArrayBuffer(encoded))
			} else {
				await this.vault.createBinary(vaultPath, toArrayBuffer(encoded))
				this.recorder?.recordCreate(path, 'file')
			}
			this.recordPath(path)
		})
	}

	async appendFile(
		path: string,
		content: FileContent,
		options?: WriteFileOptions | BufferEncoding,
	): Promise<void> {
		await this.checkPermission({ kind: 'write', path })
		await this.withBatch(async () => {
			const encoded = encodeContent(content, options)
			const existing = (await this.exists(path))
				? await this.readFileBuffer(path)
				: (new Uint8Array(0) as Uint8Array)
			const merged = new Uint8Array(existing.length + encoded.length)
			merged.set(existing)
			merged.set(encoded, existing.length)
			await this.writeFile(path, merged)
		})
	}

	async exists(path: string): Promise<boolean> {
		const normalized = ensureNotEscapingRoot(path)
		if (normalized === '/') {
			return true
		}
		return Boolean(
			this.vault.getAbstractFileByPath(this.toVaultPath(normalized)),
		)
	}

	async stat(path: string): Promise<FsStat> {
		if (ensureNotEscapingRoot(path) === '/') {
			return {
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
				mode: DIR_MODE,
				size: 0,
				mtime: new Date(0),
			}
		}
		return mapAbstractFileStat(await this.statInternal(path))
	}

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		const normalized = ensureNotEscapingRoot(path)
		if (normalized === '/') {
			return
		}
		await this.checkPermission({ kind: 'mkdir', path })

		const segments = normalized.split('/').filter(Boolean)
		let current = ''
		for (let index = 0; index < segments.length; index += 1) {
			current = `${current}/${segments[index]}`
			if (await this.exists(current)) {
				continue
			}
			if (!options?.recursive && index !== segments.length - 1) {
				throw new Error(
					`ENOENT: no such file or directory, mkdir '${normalized}'`,
				)
			}
			await this.vault.createFolder(this.toVaultPath(current))
			this.recorder?.recordCreate(current, 'dir')
			this.recordPath(current)
		}
	}

	async readdir(path: string): Promise<string[]> {
		const stat = await this.stat(path)
		if (!stat.isDirectory) {
			throw new Error(`ENOTDIR: not a directory, scandir '${path}'`)
		}
		const target =
			this.toVaultPath(path) === ''
				? this.vault.getRoot()
				: this.vault.getAbstractFileByPath(this.toVaultPath(path))
		if (!(target instanceof TFolder)) {
			throw new Error(`ENOTDIR: not a directory, scandir '${path}'`)
		}
		return [...target.children]
			.map((item) => item.name)
			.filter((item): item is string => Boolean(item))
			.sort()
	}

	async readdirWithFileTypes(path: string) {
		const stat = await this.stat(path)
		if (!stat.isDirectory) {
			throw new Error(`ENOTDIR: not a directory, scandir '${path}'`)
		}
		const target =
			this.toVaultPath(path) === ''
				? this.vault.getRoot()
				: this.vault.getAbstractFileByPath(this.toVaultPath(path))
		if (!(target instanceof TFolder)) {
			throw new Error(`ENOTDIR: not a directory, scandir '${path}'`)
		}
		return [...target.children]
			.map((item) => ({
				name: item.name,
				isFile: item instanceof TFile,
				isDirectory: item instanceof TFolder,
				isSymbolicLink: false,
			}))
			.sort((left, right) => left.name.localeCompare(right.name))
	}

	async rm(path: string, options?: RmOptions): Promise<void> {
		const normalized = ensureNotEscapingRoot(path)
		if (normalized === '/') {
			throw new Error(`EPERM: operation not permitted, remove '${path}'`)
		}
		await this.checkPermission({ kind: 'delete', path })

		if (!(await this.exists(normalized))) {
			if (options?.force) {
				return
			}
			throw new Error(`ENOENT: no such file or directory, remove '${path}'`)
		}

		const target = this.vault.getAbstractFileByPath(
			this.toVaultPath(normalized),
		)
		if (!target) {
			throw new Error(`ENOENT: no such file or directory, remove '${path}'`)
		}
		this.recordDeleteSnapshots(await this.snapshotSubtree(normalized))
		await this.deleteAbstractFile(target)
		this.forgetPath(normalized)
	}

	async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
		await this.checkPermission({ kind: 'copy', src, dest })
		await this.withBatch(() => copyRecursive(this, src, dest, options))
	}

	async mv(src: string, dest: string): Promise<void> {
		await this.checkPermission({ kind: 'move', src, dest })
		await this.withBatch(async () => {
			const sourceSnapshots = await this.snapshotSubtree(src)
			if (sourceSnapshots.length === 0) {
				throw new Error(`ENOENT: no such file or directory, move '${src}'`)
			}
			const destSnapshotsBefore = await this.snapshotSubtree(dest)
			await this.mkdir(pathPosix.dirname(ensureNotEscapingRoot(dest)), {
				recursive: true,
			})
			const target = this.vault.getAbstractFileByPath(this.toVaultPath(src))
			if (!target) {
				throw new Error(`ENOENT: no such file or directory, move '${src}'`)
			}
			this.recordDeleteSnapshots(sourceSnapshots)
			await this.vault.rename(target, this.toVaultPath(dest))
			this.forgetPath(src)
			this.recordPath(dest)
			this.recordTargetDiff(
				destSnapshotsBefore,
				await this.snapshotSubtree(dest),
			)
		})
	}

	resolvePath(base: string, path: string): string {
		return ensureNotEscapingRoot(pathPosix.resolve(base || '/', path))
	}

	getAllPaths(): string[] {
		return [...this.snapshot].sort()
	}

	async chmod(path: string, _mode: number): Promise<void> {
		await this.assertExists(path)
	}

	async symlink(_target: string, linkPath: string): Promise<void> {
		throw new Error(
			`ENOTSUP: symbolic links are not supported in vault fs, link '${linkPath}'`,
		)
	}

	async link(_existingPath: string, newPath: string): Promise<void> {
		throw new Error(
			`ENOTSUP: hard links are not supported in vault fs, link '${newPath}'`,
		)
	}

	async readlink(path: string): Promise<string> {
		throw new Error(`EINVAL: not a symbolic link, readlink '${path}'`)
	}

	async lstat(path: string): Promise<FsStat> {
		return this.stat(path)
	}

	async realpath(path: string): Promise<string> {
		await this.assertExists(path)
		return ensureNotEscapingRoot(path)
	}

	async utimes(path: string, _atime: Date, _mtime: Date): Promise<void> {
		await this.withBatch(async () => {
			const stat = await this.stat(path)
			if (stat.isDirectory) {
				return
			}
			const content = await this.readFileBuffer(path)
			await this.writeFile(path, content)
		})
	}
}

export class MountedVaultFs implements IFileSystem {
	private readonly scratch = new InMemoryFs()

	constructor(private readonly vaultFs: ObsidianVaultFs) {}

	private isRoot(path: string) {
		return ensureNotEscapingRoot(path) === '/'
	}

	private isVaultMount(path: string) {
		return ensureNotEscapingRoot(path) === VAULT_MOUNT_POINT
	}

	private isVaultPath(path: string) {
		const normalized = ensureNotEscapingRoot(path)
		return (
			normalized === VAULT_MOUNT_POINT ||
			normalized.startsWith(`${VAULT_MOUNT_POINT}/`)
		)
	}

	private toVaultRelative(path: string) {
		const normalized = ensureNotEscapingRoot(path)
		if (normalized === VAULT_MOUNT_POINT) {
			return '/'
		}
		return normalized.slice(VAULT_MOUNT_POINT.length) || '/'
	}

	private route(path: string) {
		const normalized = ensureNotEscapingRoot(path)
		if (this.isVaultPath(normalized)) {
			return {
				fs: this.vaultFs as IFileSystem,
				path: this.toVaultRelative(normalized),
			}
		}
		return {
			fs: this.scratch as IFileSystem,
			path: normalized,
		}
	}

	private async genericCp(src: string, dest: string, options?: CpOptions) {
		const sourceStat = await this.stat(src)
		if (sourceStat.isDirectory) {
			if (!options?.recursive) {
				throw new Error(
					`EISDIR: illegal operation on a directory, copy '${src}'`,
				)
			}
			await this.mkdir(dest, { recursive: true })
			for (const entry of await this.readdir(src)) {
				await this.genericCp(
					joinVirtualPath(src, entry),
					joinVirtualPath(dest, entry),
					options,
				)
			}
			return
		}
		await this.writeFile(dest, await this.readFileBuffer(src))
	}

	async readFile(
		path: string,
		options?: ReadFileOptions | BufferEncoding,
	): Promise<string> {
		if (this.isVaultMount(path)) {
			throw new Error(
				`EISDIR: illegal operation on a directory, read '${path}'`,
			)
		}
		const routed = this.route(path)
		return routed.fs.readFile(routed.path, options)
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		if (this.isVaultMount(path)) {
			throw new Error(
				`EISDIR: illegal operation on a directory, read '${path}'`,
			)
		}
		const routed = this.route(path)
		return routed.fs.readFileBuffer(routed.path)
	}

	async writeFile(
		path: string,
		content: FileContent,
		options?: WriteFileOptions | BufferEncoding,
	): Promise<void> {
		if (this.isRoot(path) || this.isVaultMount(path)) {
			throw new Error(
				`EISDIR: illegal operation on a directory, write '${path}'`,
			)
		}
		const routed = this.route(path)
		await routed.fs.writeFile(routed.path, content, options)
	}

	async appendFile(
		path: string,
		content: FileContent,
		options?: WriteFileOptions | BufferEncoding,
	): Promise<void> {
		if (this.isRoot(path) || this.isVaultMount(path)) {
			throw new Error(
				`EISDIR: illegal operation on a directory, append '${path}'`,
			)
		}
		const routed = this.route(path)
		await routed.fs.appendFile(routed.path, content, options)
	}

	async exists(path: string): Promise<boolean> {
		if (this.isRoot(path) || this.isVaultMount(path)) {
			return true
		}
		const routed = this.route(path)
		return routed.fs.exists(routed.path)
	}

	async stat(path: string): Promise<FsStat> {
		if (this.isRoot(path) || this.isVaultMount(path)) {
			return {
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
				mode: DIR_MODE,
				size: 0,
				mtime: new Date(0),
			}
		}
		const routed = this.route(path)
		return routed.fs.stat(routed.path)
	}

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		if (this.isRoot(path) || this.isVaultMount(path)) {
			return
		}
		const routed = this.route(path)
		await routed.fs.mkdir(routed.path, options)
	}

	async readdir(path: string): Promise<string[]> {
		if (this.isRoot(path)) {
			const base = await this.scratch.readdir('/')
			return [...new Set(['vault', ...base])].sort()
		}
		if (this.isVaultMount(path)) {
			return this.vaultFs.readdir('/')
		}
		const routed = this.route(path)
		return routed.fs.readdir(routed.path)
	}

	async readdirWithFileTypes(path: string) {
		if (this.isRoot(path)) {
			const base = this.scratch.readdirWithFileTypes
				? await this.scratch.readdirWithFileTypes('/')
				: (await this.scratch.readdir('/')).map((name) => ({
						name,
						isFile: true,
						isDirectory: false,
						isSymbolicLink: false,
					}))
			return [
				{
					name: 'vault',
					isFile: false,
					isDirectory: true,
					isSymbolicLink: false,
				},
				...base.filter((entry) => entry.name !== 'vault'),
			].sort((left, right) => left.name.localeCompare(right.name))
		}
		if (this.isVaultMount(path)) {
			return this.vaultFs.readdirWithFileTypes?.('/') ?? []
		}
		const routed = this.route(path)
		return routed.fs.readdirWithFileTypes?.(routed.path) ?? []
	}

	async rm(path: string, options?: RmOptions): Promise<void> {
		if (this.isRoot(path) || this.isVaultMount(path)) {
			throw new Error(`EPERM: operation not permitted, remove '${path}'`)
		}
		const routed = this.route(path)
		return routed.fs.rm(routed.path, options)
	}

	async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
		await this.genericCp(src, dest, options)
	}

	async mv(src: string, dest: string): Promise<void> {
		if (this.isRoot(src) || this.isVaultMount(src)) {
			throw new Error(`EPERM: operation not permitted, move '${src}'`)
		}
		const source = this.route(src)
		const target = this.route(dest)
		if (source.fs === target.fs) {
			await source.fs.mv(source.path, target.path)
			return
		}
		await this.genericCp(src, dest, { recursive: true })
		await removeRecursive(this, src, { recursive: true, force: false })
	}

	resolvePath(base: string, path: string): string {
		return ensureNotEscapingRoot(pathPosix.resolve(base || '/', path))
	}

	getAllPaths(): string[] {
		const basePaths = this.scratch.getAllPaths().filter((path) => path !== '/')
		const vaultPaths = this.vaultFs
			.getAllPaths()
			.filter((path) => path !== '/')
			.map((path) => `${VAULT_MOUNT_POINT}${path}`)
		return ['/', VAULT_MOUNT_POINT, ...basePaths, ...vaultPaths].sort()
	}

	async chmod(path: string, mode: number): Promise<void> {
		if (this.isRoot(path) || this.isVaultMount(path)) {
			return
		}
		const routed = this.route(path)
		await routed.fs.chmod(routed.path, mode)
	}

	async symlink(target: string, linkPath: string): Promise<void> {
		if (this.isVaultPath(linkPath) || this.isVaultPath(target)) {
			throw new Error(
				`ENOTSUP: symbolic links are not supported in vault fs, link '${linkPath}'`,
			)
		}
		return this.scratch.symlink(target, linkPath)
	}

	async link(existingPath: string, newPath: string): Promise<void> {
		if (this.isVaultPath(existingPath) || this.isVaultPath(newPath)) {
			throw new Error(
				`ENOTSUP: hard links are not supported in vault fs, link '${newPath}'`,
			)
		}
		return this.scratch.link(existingPath, newPath)
	}

	async readlink(path: string): Promise<string> {
		if (this.isVaultPath(path)) {
			throw new Error(`EINVAL: not a symbolic link, readlink '${path}'`)
		}
		return this.scratch.readlink(path)
	}

	async lstat(path: string): Promise<FsStat> {
		return this.stat(path)
	}

	async realpath(path: string): Promise<string> {
		await this.stat(path)
		return ensureNotEscapingRoot(path)
	}

	async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
		if (this.isRoot(path) || this.isVaultMount(path)) {
			return
		}
		const routed = this.route(path)
		await routed.fs.utimes(routed.path, atime, mtime)
	}
}

export { VAULT_MOUNT_POINT }
