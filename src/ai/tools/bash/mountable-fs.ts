import type {
	BufferEncoding,
	CpOptions,
	CreateExclusiveOptions,
	FileContent,
	FsStat,
	IFileSystem,
	MkdirOptions,
	RmOptions,
} from 'just-bash/browser'
import { InMemoryFs } from 'just-bash/browser'
import { posix as pathPosix } from 'path-browserify'
import { isNotFoundError } from './fs'
import {
	assertCanonicalVirtualPathCharacters,
	normalizeVirtualPath,
} from './virtual-path'

type ReadFileOptions = Parameters<IFileSystem['readFile']>[1]
type WriteFileOptions = Parameters<IFileSystem['writeFile']>[2]
type DirentEntry = Awaited<
	ReturnType<NonNullable<IFileSystem['readdirWithFileTypes']>>
>[number]

export interface MountConfig {
	mountPoint: string
	filesystem: IFileSystem
}

export interface MountableFsOptions {
	base?: IFileSystem
	mounts?: readonly MountConfig[]
}

interface RoutedPath {
	normalized: string
	filesystem: IFileSystem
	relativePath: string
	mountPoint?: string
}

interface WriteTransformAwareFs extends IFileSystem {
	transformsWritesAt?: (path: string) => boolean
}

const VIRTUAL_DIR_MODE = 0o755

function virtualDirStat(): FsStat {
	return {
		isFile: false,
		isDirectory: true,
		isSymbolicLink: false,
		mode: VIRTUAL_DIR_MODE,
		size: 0,
		mtime: new Date(0),
	}
}

function joinVirtualPath(parent: string, child: string): string {
	return parent === '/' ? `/${child}` : `${parent}/${child}`
}

function isDescendantOrSame(ancestor: string, candidate: string): boolean {
	if (ancestor === candidate) return true
	if (ancestor === '/') return candidate.startsWith('/')
	return candidate.startsWith(`${ancestor}/`)
}

function compareEntryNames(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Virtual filesystem router that canonicalizes every path once, enforces mount
 * boundaries (`EBUSY` on mount ancestors, `EXDEV` across mounts, `EINVAL` on
 * self-containment), and delegates `readdirWithFileTypes` natively without
 * falling back to N+1 `lstat` calls.
 */
export class MountableFs implements IFileSystem {
	private readonly baseFs: IFileSystem
	private readonly mounts = new Map<string, IFileSystem>()

	constructor(options: MountableFsOptions = {}) {
		this.baseFs = options.base ?? new InMemoryFs()
		for (const mount of options.mounts ?? []) {
			this.mount(mount.mountPoint, mount.filesystem)
		}
	}

	mount(mountPoint: string, filesystem: IFileSystem) {
		assertCanonicalVirtualPathCharacters(mountPoint)
		for (const segment of mountPoint.split('/')) {
			if (segment === '.' || segment === '..') {
				throw new Error(
					`Invalid mount point '${mountPoint}': contains '.' or '..' segments`,
				)
			}
		}
		const normalized = normalizeVirtualPath(mountPoint)
		if (normalized === '/') {
			throw new Error("Cannot mount at root '/'")
		}
		for (const existing of this.mounts.keys()) {
			if (existing === normalized) continue
			if (normalized.startsWith(`${existing}/`)) {
				throw new Error(
					`Cannot mount at '${normalized}': inside existing mount '${existing}'`,
				)
			}
			if (existing.startsWith(`${normalized}/`)) {
				throw new Error(
					`Cannot mount at '${normalized}': would contain existing mount '${existing}'`,
				)
			}
		}
		this.mounts.set(normalized, filesystem)
	}

	unmount(mountPoint: string) {
		const normalized = normalizeVirtualPath(mountPoint)
		if (!this.mounts.has(normalized)) {
			throw new Error(`No filesystem mounted at '${mountPoint}'`)
		}
		this.mounts.delete(normalized)
	}

	getMounts(): Array<{ mountPoint: string; filesystem: IFileSystem }> {
		return Array.from(this.mounts, ([mountPoint, filesystem]) => ({
			mountPoint,
			filesystem,
		}))
	}

	isMountPoint(path: string): boolean {
		return this.mounts.has(normalizeVirtualPath(path))
	}

	transformsWritesAt(path: string): boolean {
		const { filesystem, relativePath } = this.route(path)
		return (
			(filesystem as WriteTransformAwareFs).transformsWritesAt?.(
				relativePath,
			) === true
		)
	}

	private route(inputPath: string): RoutedPath {
		const normalized = normalizeVirtualPath(inputPath)
		for (const [mountPoint, filesystem] of this.mounts) {
			if (normalized === mountPoint) {
				return {
					normalized,
					filesystem,
					relativePath: '/',
					mountPoint,
				}
			}
			if (normalized.startsWith(`${mountPoint}/`)) {
				return {
					normalized,
					filesystem,
					relativePath: normalized.slice(mountPoint.length),
					mountPoint,
				}
			}
		}
		return {
			normalized,
			filesystem: this.baseFs,
			relativePath: normalized,
		}
	}

	private hasChildMount(normalized: string): boolean {
		if (this.mounts.size === 0) return false
		if (normalized === '/') return true
		const prefix = `${normalized}/`
		for (const mountPoint of this.mounts.keys()) {
			if (mountPoint.startsWith(prefix)) return true
		}
		return false
	}

	private getChildMountNames(normalized: string): string[] {
		if (this.mounts.size === 0) return []
		const prefix = normalized === '/' ? '/' : `${normalized}/`
		const children: string[] = []
		for (const mountPoint of this.mounts.keys()) {
			if (!mountPoint.startsWith(prefix)) continue
			const rest = mountPoint.slice(prefix.length)
			const slashIndex = rest.indexOf('/')
			const name = slashIndex === -1 ? rest : rest.slice(0, slashIndex)
			if (name && !children.includes(name)) {
				children.push(name)
			}
		}
		return children
	}

	/** A base directory operation must never bypass a mounted filesystem's policy. */
	private assertUnmountedTree(normalized: string, rawPath: string) {
		if (this.mounts.size === 0) return
		if (normalized === '/') {
			throw new Error(
				`EBUSY: directory contains a filesystem mount, '${rawPath}'`,
			)
		}
		const prefix = `${normalized}/`
		for (const mountPoint of this.mounts.keys()) {
			if (mountPoint === normalized || mountPoint.startsWith(prefix)) {
				throw new Error(
					`EBUSY: directory contains a filesystem mount, '${rawPath}'`,
				)
			}
		}
	}

	async readFile(
		path: string,
		options?: ReadFileOptions | BufferEncoding,
	): Promise<string> {
		const { filesystem, relativePath } = this.route(path)
		return filesystem.readFile(relativePath, options)
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const { filesystem, relativePath } = this.route(path)
		return filesystem.readFileBuffer(relativePath)
	}

	async writeFile(
		path: string,
		content: FileContent,
		options?: WriteFileOptions | BufferEncoding,
	): Promise<void> {
		const { filesystem, relativePath } = this.route(path)
		return filesystem.writeFile(relativePath, content, options)
	}

	async appendFile(
		path: string,
		content: FileContent,
		options?: WriteFileOptions | BufferEncoding,
	): Promise<void> {
		const { filesystem, relativePath } = this.route(path)
		return filesystem.appendFile(relativePath, content, options)
	}

	async exists(path: string): Promise<boolean> {
		const { normalized, filesystem, relativePath, mountPoint } =
			this.route(path)
		if (mountPoint === normalized || this.hasChildMount(normalized)) {
			return true
		}
		return filesystem.exists(relativePath)
	}

	async stat(path: string): Promise<FsStat> {
		const { normalized, filesystem, relativePath, mountPoint } =
			this.route(path)
		if (mountPoint === normalized) {
			try {
				return await filesystem.stat('/')
			} catch {
				return virtualDirStat()
			}
		}
		if (this.hasChildMount(normalized)) {
			try {
				return await this.baseFs.stat(normalized)
			} catch {
				return virtualDirStat()
			}
		}
		return filesystem.stat(relativePath)
	}

	async lstat(path: string): Promise<FsStat> {
		const { normalized, filesystem, relativePath, mountPoint } =
			this.route(path)
		if (mountPoint === normalized) {
			try {
				return await filesystem.lstat('/')
			} catch {
				return virtualDirStat()
			}
		}
		if (this.hasChildMount(normalized)) {
			try {
				return await this.baseFs.lstat(normalized)
			} catch {
				return virtualDirStat()
			}
		}
		return filesystem.lstat(relativePath)
	}

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		const { normalized, filesystem, relativePath, mountPoint } =
			this.route(path)
		if (mountPoint === normalized) {
			if (options?.recursive) return
			throw new Error(`EEXIST: directory already exists, mkdir '${path}'`)
		}
		if (this.hasChildMount(normalized) && options?.recursive) {
			return
		}
		return filesystem.mkdir(relativePath, options)
	}

	async createExclusive(
		path: string,
		options: CreateExclusiveOptions,
	): Promise<void> {
		const { normalized, filesystem, relativePath, mountPoint } =
			this.route(path)
		const op = options.directory ? 'mkdir' : 'open'
		if (mountPoint === normalized) {
			throw new Error(`EEXIST: file already exists, ${op} '${path}'`)
		}
		if (!filesystem.createExclusive) {
			throw new Error(
				`ENOSYS: atomic exclusive ${op} not supported for '${path}'`,
			)
		}
		const parentRelative = pathPosix.dirname(relativePath)
		const parentNormalized = pathPosix.dirname(normalized)
		if (
			parentRelative !== '/' &&
			this.hasChildMount(parentNormalized) &&
			!(await filesystem.exists(parentRelative))
		) {
			await filesystem.mkdir(parentRelative, { recursive: true })
		}
		return filesystem.createExclusive(relativePath, options)
	}

	async readdir(path: string): Promise<string[]> {
		const { normalized, filesystem, relativePath, mountPoint } =
			this.route(path)
		const names = new Set<string>()
		let readError: Error | undefined
		try {
			for (const name of await filesystem.readdir(relativePath)) {
				names.add(name)
			}
		} catch (error) {
			if (!isNotFoundError(error)) throw error
			readError = error
		}
		for (const childName of this.getChildMountNames(normalized)) {
			names.add(childName)
		}
		if (names.size === 0 && readError && mountPoint !== normalized) {
			throw readError
		}
		return Array.from(names).sort(compareEntryNames)
	}

	async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
		const { normalized, filesystem, relativePath, mountPoint } =
			this.route(path)
		const entries = new Map<string, DirentEntry>()
		let readError: Error | undefined
		try {
			const list = filesystem.readdirWithFileTypes
				? await filesystem.readdirWithFileTypes(relativePath)
				: await this.fallbackReaddirWithFileTypes(filesystem, relativePath)
			for (const entry of list) {
				entries.set(entry.name, entry)
			}
		} catch (error) {
			if (!isNotFoundError(error)) throw error
			readError = error
		}
		// Child mounts are virtual directories and take precedence over any
		// identically named entry in the underlying filesystem.
		for (const childName of this.getChildMountNames(normalized)) {
			entries.set(childName, {
				name: childName,
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
			})
		}
		if (entries.size === 0 && readError && mountPoint !== normalized) {
			throw readError
		}
		return Array.from(entries.values()).sort((left, right) =>
			compareEntryNames(left.name, right.name),
		)
	}

	private async fallbackReaddirWithFileTypes(
		filesystem: IFileSystem,
		relativePath: string,
	): Promise<DirentEntry[]> {
		const names = await filesystem.readdir(relativePath)
		return Promise.all(
			names.map(async (name) => {
				const stat = await filesystem.lstat(joinVirtualPath(relativePath, name))
				return {
					name,
					isFile: stat.isFile,
					isDirectory: stat.isDirectory,
					isSymbolicLink: stat.isSymbolicLink,
				}
			}),
		)
	}

	async rm(path: string, options?: RmOptions): Promise<void> {
		const { normalized, filesystem, relativePath } = this.route(path)
		this.assertUnmountedTree(normalized, path)
		return filesystem.rm(relativePath, options)
	}

	async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
		const source = this.route(src)
		const target = this.route(dest)
		if (
			isDescendantOrSame(source.normalized, target.normalized) &&
			(await this.stat(source.normalized)).isDirectory
		) {
			throw new Error(`EINVAL: cannot copy '${src}' into itself, '${dest}'`)
		}
		if (source.filesystem === target.filesystem) {
			return source.filesystem.cp(
				source.relativePath,
				target.relativePath,
				options,
			)
		}
		await this.copyAcrossMounts(source.normalized, target.normalized, options)
	}

	private async copyAcrossMounts(
		src: string,
		dest: string,
		options?: CpOptions,
	): Promise<void> {
		const stat = await this.lstat(src)
		if (stat.isSymbolicLink) {
			await this.symlink(await this.readlink(src), dest)
			return
		}
		if (stat.isDirectory) {
			if (!options?.recursive) {
				throw new Error(`cp: ${src} is a directory (not copied)`)
			}
			await this.mkdir(dest, { recursive: true })
			for (const entry of await this.readdirWithFileTypes(src)) {
				await this.copyAcrossMounts(
					joinVirtualPath(src, entry.name),
					joinVirtualPath(dest, entry.name),
					options,
				)
			}
			return
		}
		await this.writeFile(dest, await this.readFileBuffer(src))
	}

	async mv(src: string, dest: string): Promise<void> {
		const source = this.route(src)
		const target = this.route(dest)
		this.assertUnmountedTree(source.normalized, src)
		this.assertUnmountedTree(target.normalized, dest)
		// Copy-and-delete across mounts would bypass the source's rename policy.
		if (source.filesystem !== target.filesystem) {
			throw new Error('EXDEV: cannot move across filesystem mounts')
		}
		if (
			source.normalized !== target.normalized &&
			isDescendantOrSame(source.normalized, target.normalized) &&
			(await this.stat(source.normalized)).isDirectory
		) {
			throw new Error(`EINVAL: cannot move '${src}' into itself, '${dest}'`)
		}
		return source.filesystem.mv(source.relativePath, target.relativePath)
	}

	resolvePath(base: string, path: string): string {
		assertCanonicalVirtualPathCharacters(base || '/')
		assertCanonicalVirtualPathCharacters(path)
		return normalizeVirtualPath(
			pathPosix.resolve(
				normalizeVirtualPath(base || '/'),
				path.normalize('NFC'),
			),
		)
	}

	getAllPaths(): string[] {
		const paths = new Set<string>()
		for (const path of this.baseFs.getAllPaths()) {
			paths.add(path)
		}
		for (const [mountPoint, filesystem] of this.mounts) {
			let ancestor = ''
			for (const part of mountPoint.split('/').filter(Boolean)) {
				ancestor = `${ancestor}/${part}`
				paths.add(ancestor)
			}
			for (const subPath of filesystem.getAllPaths()) {
				paths.add(subPath === '/' ? mountPoint : `${mountPoint}${subPath}`)
			}
		}
		return Array.from(paths).sort(compareEntryNames)
	}

	async chmod(path: string, mode: number): Promise<void> {
		const { filesystem, relativePath } = this.route(path)
		return filesystem.chmod(relativePath, mode)
	}

	async symlink(target: string, linkPath: string): Promise<void> {
		assertCanonicalVirtualPathCharacters(target)
		const { filesystem, relativePath } = this.route(linkPath)
		return filesystem.symlink(target.normalize('NFC'), relativePath)
	}

	async link(existingPath: string, newPath: string): Promise<void> {
		const source = this.route(existingPath)
		const target = this.route(newPath)
		if (source.filesystem !== target.filesystem) {
			throw new Error(
				`EXDEV: cross-device link not permitted, link '${existingPath}' -> '${newPath}'`,
			)
		}
		return source.filesystem.link(source.relativePath, target.relativePath)
	}

	async readlink(path: string): Promise<string> {
		const { filesystem, relativePath } = this.route(path)
		const target = await filesystem.readlink(relativePath)
		assertCanonicalVirtualPathCharacters(target)
		return target.normalize('NFC')
	}

	async realpath(path: string): Promise<string> {
		const { normalized, filesystem, relativePath, mountPoint } =
			this.route(path)
		if (mountPoint === normalized) {
			return normalized
		}
		const resolved = await filesystem.realpath(relativePath)
		if (mountPoint) {
			return normalizeVirtualPath(
				resolved === '/' ? mountPoint : `${mountPoint}${resolved}`,
			)
		}
		return normalizeVirtualPath(resolved)
	}

	async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
		const { filesystem, relativePath } = this.route(path)
		return filesystem.utimes(relativePath, atime, mtime)
	}
}
