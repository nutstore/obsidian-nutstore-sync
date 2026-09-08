import { fromUint8Array } from 'js-base64'
import {
	type BufferEncoding,
	type CpOptions,
	type FileContent,
	type FsStat,
	type IFileSystem,
	type MkdirOptions,
	type RmOptions,
} from 'just-bash/browser'
import { normalizePath, TFile, TFolder, type App } from 'obsidian'
import { posix as pathPosix } from 'path-browserify'
import { decodeReversibleFileSnapshot } from '~/ai/chat/messages/reversible-content'
import type { ReversibleFileSnapshot, ReversibleToolOp } from '~/ai/chat/types'
import { listAvailableAdapterEntries } from '~/ai/tools/available-adapter-entries'
import type {
	AIDualPathFileOperation,
	AISinglePathFileOperation,
} from '~/ai/tools/file-operation'
import type { PermissionGuard } from '~/ai/tools/permission-guard'
import {
	existsLocalPath,
	isAdapterPath,
	readLocalBinary,
	removeLocalPath,
	writeLocalBinary,
} from '~/utils/local-vault-io'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import { statVaultItem } from '~/utils/stat-vault-item'
import { AGENTS_VAULT_PATH } from './mount-points'

const FILE_MODE = 0o644
const DIR_MODE = 0o755
type ReadFileOptions = { encoding?: BufferEncoding | null }
type WriteFileOptions = { encoding?: BufferEncoding }

function getEncoding(
	options?: ReadFileOptions | WriteFileOptions | BufferEncoding | null,
) {
	if (!options) {
		return 'utf8'
	}
	return typeof options === 'string' ? options : (options.encoding ?? 'utf8')
}

export function decodeContent(
	content: Uint8Array,
	options?: ReadFileOptions | BufferEncoding,
) {
	const encoding = getEncoding(options)
	if (encoding === 'base64') {
		return fromUint8Array(content, false)
	}
	if (encoding === 'hex') {
		return Array.from(content)
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('')
	}
	if (encoding === 'binary' || encoding === 'latin1') {
		const chunkSize = 0x8000
		let result = ''
		for (let i = 0; i < content.length; i += chunkSize) {
			result += String.fromCharCode(
				...content.subarray(i, Math.min(i + chunkSize, content.length)),
			)
		}
		return result
	}
	return new TextDecoder('utf-8').decode(content)
}

export function encodeContent(
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
	if (encoding === 'hex') {
		const bytes = new Uint8Array(content.length / 2)
		for (let i = 0; i < content.length; i += 2) {
			bytes[i / 2] = Number.parseInt(content.slice(i, i + 2), 16)
		}
		return bytes
	}
	if (encoding === 'binary' || encoding === 'latin1') {
		const bytes = new Uint8Array(content.length)
		for (let i = 0; i < content.length; i++) {
			bytes[i] = content.charCodeAt(i) & 0xff
		}
		return bytes
	}

	return new TextEncoder().encode(content)
}

export function toArrayBuffer(content: Uint8Array) {
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

interface VaultPathIndex {
	getAllPaths(): string[]
	recordPath(path: string): void
	forgetPath(path: string): void
}

class MutableVaultPathIndex implements VaultPathIndex {
	private readonly paths = new Set<string>(['/'])

	constructor(initialPaths: string[] = []) {
		for (const path of initialPaths) this.recordPath(path)
	}

	recordPath(inputPath: string) {
		const normalized = ensureNotEscapingRoot(inputPath)
		this.paths.add('/')
		let current = ''
		for (const part of normalized.split('/').filter(Boolean)) {
			current = `${current}/${part}`
			this.paths.add(current)
		}
	}

	forgetPath(inputPath: string) {
		const normalized = ensureNotEscapingRoot(inputPath)
		for (const path of [...this.paths]) {
			if (path === normalized || path.startsWith(`${normalized}/`)) {
				this.paths.delete(path)
			}
		}
		this.paths.add('/')
	}

	getAllPaths() {
		return [...this.paths].sort()
	}
}

export class ReversibleOpRecorder {
	private captureDepth = 0
	private readonly virtualInitial = new Map<
		string,
		ReversibleFileSnapshot | { kind: 'dir' } | undefined
	>()
	private readonly virtualLatest = new Map<
		string,
		ReversibleFileSnapshot | { kind: 'dir' } | undefined
	>()

	get isCapturing() {
		return this.captureDepth > 0
	}
	beginCapture() {
		this.captureDepth++
	}
	endCapture() {
		this.captureDepth--
	}

	recordVirtualTransition(
		path: string,
		before: ReversibleFileSnapshot | { kind: 'dir' } | undefined,
		after: ReversibleFileSnapshot | { kind: 'dir' } | undefined,
	) {
		if (!this.virtualInitial.has(path)) this.virtualInitial.set(path, before)
		this.virtualLatest.set(path, after)
	}

	private async sameFileContent(
		left: Extract<ReversibleToolOp, { operation: 'update' }>['before'],
		right: Extract<ReversibleToolOp, { operation: 'update' }>['before'],
	) {
		const [leftBuffer, rightBuffer] = await Promise.all([
			decodeReversibleFileSnapshot(left),
			decodeReversibleFileSnapshot(right),
		])
		const leftBytes = new Uint8Array(leftBuffer)
		const rightBytes = new Uint8Array(rightBuffer)
		return (
			leftBytes.length === rightBytes.length &&
			leftBytes.every((byte, index) => byte === rightBytes[index])
		)
	}

	async getNetOperations(): Promise<ReversibleToolOp[]> {
		const result: ReversibleToolOp[] = []
		for (const [path, initial] of [...this.virtualInitial].sort(
			([left], [right]) => {
				const depth = getPathDepth(left) - getPathDepth(right)
				return depth !== 0 ? depth : left.localeCompare(right)
			},
		)) {
			const after = this.virtualLatest.get(path)
			if (!initial && after) {
				result.push({
					vaultPath: path,
					operation: 'create',
					before: { kind: after.kind },
					after,
				})
			} else if (initial && !after) {
				result.push({ vaultPath: path, operation: 'delete', before: initial })
			} else if (initial?.kind === 'file' && after?.kind === 'file') {
				if (!(await this.sameFileContent(initial, after))) {
					result.push({
						vaultPath: path,
						operation: 'update',
						before: initial,
						after,
					})
				}
			} else if (initial && after && initial.kind !== after.kind) {
				result.push({ vaultPath: path, operation: 'delete', before: initial })
				result.push({
					vaultPath: path,
					operation: 'create',
					before: { kind: after.kind },
					after,
				})
			}
		}
		return result
	}
}

export class ObsidianVaultFs implements IFileSystem {
	private _batchDepth = 0
	private readonly pathIndex: VaultPathIndex

	constructor(
		private readonly app: Pick<App, 'vault' | 'fileManager'>,
		initialPaths: string[] | VaultPathIndex = [],
		private readonly permissionGuard?: PermissionGuard,
		private readonly onRead?: (vaultPath: string) => void,
	) {
		this.pathIndex = Array.isArray(initialPaths)
			? new MutableVaultPathIndex(initialPaths)
			: initialPaths
	}

	private get vault() {
		return this.app.vault
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
		return normalized
	}

	private toVaultPath(inputPath: string) {
		const normalized = ensureNotEscapingRoot(inputPath)
		return normalized === '/' ? '' : normalizePath(normalized.slice(1))
	}

	private isInternalDirectory(inputPath: string) {
		const normalized = ensureNotEscapingRoot(inputPath)
		const configDir = `/${normalizePath(this.vault.configDir)}`
		return normalized === `/${AGENTS_VAULT_PATH}` || normalized === configDir
	}

	private async listDirectory(inputPath: string) {
		const normalized = ensureNotEscapingRoot(inputPath)
		const adapterPath = this.toVaultPath(normalized)
		if (typeof this.vault.adapter.list === 'function') {
			if (
				this.isInternalDirectory(normalized) &&
				!(await this.vault.adapter.exists(adapterPath))
			) {
				return { files: [], folders: [] }
			}
			const listed = await listAvailableAdapterEntries(
				this.vault.adapter,
				adapterPath,
			)
			if (normalized === '/') {
				const folders = new Set(listed.folders)
				folders.add(AGENTS_VAULT_PATH)
				folders.add(normalizePath(this.vault.configDir))
				return { files: listed.files, folders: [...folders] }
			}
			return listed
		}

		const target =
			adapterPath === ''
				? this.vault.getRoot()
				: this.vault.getAbstractFileByPath(adapterPath)
		if (!(target instanceof TFolder)) {
			if (this.isInternalDirectory(normalized)) {
				return { files: [], folders: [] }
			}
			throw new Error(`ENOTDIR: not a directory, scandir '${inputPath}'`)
		}
		const files: string[] = []
		const folders: string[] = []
		for (const child of target.children) {
			if (child instanceof TFile) files.push(child.path)
			if (child instanceof TFolder) folders.push(child.path)
		}
		if (normalized === '/') {
			folders.push(AGENTS_VAULT_PATH, normalizePath(this.vault.configDir))
		}
		return { files, folders }
	}

	private recordPath(inputPath: string) {
		this.pathIndex.recordPath(inputPath)
	}

	private forgetPath(inputPath: string) {
		this.pathIndex.forgetPath(inputPath)
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
			await readLocalBinary(this.vault, this.toVaultPath(path)),
		)
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
			await writeLocalBinary(
				this.vault,
				this.toVaultPath(path),
				toArrayBuffer(encoded),
			)
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
				? await this.readInternal(path)
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
		if (this.isInternalDirectory(normalized)) return true
		return await existsLocalPath(this.vault, this.toVaultPath(normalized))
	}

	async stat(path: string): Promise<FsStat> {
		const normalized = ensureNotEscapingRoot(path)
		if (normalized === '/') {
			return {
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
				mode: DIR_MODE,
				size: 0,
				mtime: new Date(0),
			}
		}
		if (
			this.isInternalDirectory(normalized) &&
			!(await this.vault.adapter.exists(this.toVaultPath(normalized)))
		) {
			return {
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
				mode: DIR_MODE,
				size: 0,
				mtime: new Date(0),
			}
		}
		const stat = await statVaultItem(this.vault, this.toVaultPath(normalized))
		if (!stat) {
			throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
		}
		const adapterStat =
			stat.isDir && stat.mtime === undefined
				? await this.vault.adapter.stat(this.toVaultPath(normalized))
				: undefined
		return {
			isFile: !stat.isDir,
			isDirectory: stat.isDir,
			isSymbolicLink: false,
			mode: stat.isDir ? DIR_MODE : FILE_MODE,
			size: stat.isDir ? 0 : (stat.size ?? 0),
			mtime: new Date(stat.mtime ?? adapterStat?.mtime ?? 0),
		}
	}

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		const normalized = ensureNotEscapingRoot(path)
		if (normalized === '/') {
			return
		}
		await this.checkPermission({ kind: 'mkdir', path })
		if (!options?.recursive) {
			const parent = pathPosix.dirname(normalized)
			if (!(await this.exists(parent))) {
				throw new Error(
					`ENOENT: no such file or directory, mkdir '${normalized}'`,
				)
			}
		}
		await mkdirsVault(this.vault, this.toVaultPath(normalized))
		this.recordPath(normalized)
	}

	async readdir(path: string): Promise<string[]> {
		const stat = await this.stat(path)
		if (!stat.isDirectory) {
			throw new Error(`ENOTDIR: not a directory, scandir '${path}'`)
		}
		const listed = await this.listDirectory(path)
		return [...listed.files, ...listed.folders]
			.map((item) => pathPosix.basename(normalizePath(item)))
			.sort()
	}

	async readdirWithFileTypes(path: string) {
		const stat = await this.stat(path)
		if (!stat.isDirectory) {
			throw new Error(`ENOTDIR: not a directory, scandir '${path}'`)
		}
		const listed = await this.listDirectory(path)
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

		const vaultPath = this.toVaultPath(normalized)
		await removeLocalPath(this.app, vaultPath, options?.recursive ?? false)
		this.forgetPath(normalized)
	}

	async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
		await this.checkPermission({ kind: 'copy', src, dest })
		await this.withBatch(() => copyRecursive(this, src, dest, options))
	}

	async mv(src: string, dest: string): Promise<void> {
		await this.checkPermission({ kind: 'move', src, dest })
		await this.withBatch(async () => {
			if (!(await this.exists(src))) {
				throw new Error(`ENOENT: no such file or directory, move '${src}'`)
			}
			await this.mkdir(pathPosix.dirname(ensureNotEscapingRoot(dest)), {
				recursive: true,
			})
			const sourceIsAdapterPath = isAdapterPath(
				this.vault,
				this.toVaultPath(src),
			)
			const destinationIsAdapterPath = isAdapterPath(
				this.vault,
				this.toVaultPath(dest),
			)
			if (sourceIsAdapterPath !== destinationIsAdapterPath) {
				await copyRecursive(this, src, dest, { recursive: true })
				await this.rm(src, { recursive: true })
			} else if (sourceIsAdapterPath) {
				await this.vault.adapter.rename(
					this.toVaultPath(src),
					this.toVaultPath(dest),
				)
			} else {
				const target = this.vault.getAbstractFileByPath(this.toVaultPath(src))
				if (!target) {
					throw new Error(`ENOENT: no such file or directory, move '${src}'`)
				}
				await this.vault.rename(target, this.toVaultPath(dest))
			}
			this.forgetPath(src)
			this.recordPath(dest)
		})
	}

	resolvePath(base: string, path: string): string {
		return ensureNotEscapingRoot(pathPosix.resolve(base || '/', path))
	}

	getAllPaths(): string[] {
		return this.pathIndex.getAllPaths()
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
			const content = await this.readInternal(path)
			await this.writeFile(path, content)
		})
	}
}

export { VAULT_MOUNT_POINT } from './mount-points'
