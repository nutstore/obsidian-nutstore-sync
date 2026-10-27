import {
	MountableFs as BashMountableFs,
	type CpOptions,
	type CreateExclusiveOptions,
	type FileContent,
	type FsStat,
	type IFileSystem,
	type MkdirOptions,
	type RmOptions,
} from 'just-bash/browser'
import {
	assertCanonicalVirtualPathCharacters,
	normalizeVirtualPath,
} from './virtual-path'

/** Directory types follow the same mount routing and virtual parents as ordinary reads. */
export class MountableFs extends BashMountableFs {
	/** Resolve every path before it can influence mount selection or permissions. */
	private path(inputPath: string) {
		return normalizeVirtualPath(inputPath)
	}

	/** A base directory operation must never bypass a mounted filesystem's policy. */
	private assertUnmountedTree(path: string) {
		const normalized = this.path(path)
		if (
			this.getMounts().some(
				({ mountPoint }) =>
					normalized === '/' ||
					mountPoint === normalized ||
					mountPoint.startsWith(`${normalized}/`),
			)
		)
			throw new Error(`EBUSY: directory contains a filesystem mount, '${path}'`)
	}

	mount(mountPoint: string, filesystem: IFileSystem) {
		super.mount(this.path(mountPoint), filesystem)
	}

	unmount(mountPoint: string) {
		super.unmount(this.path(mountPoint))
	}

	isMountPoint(path: string) {
		return super.isMountPoint(this.path(path))
	}

	async readFile(
		path: string,
		options?: Parameters<BashMountableFs['readFile']>[1],
	) {
		return super.readFile(this.path(path), options)
	}

	async readFileBytes(path: string) {
		return super.readFileBytes(this.path(path))
	}

	async readFileBuffer(path: string) {
		return super.readFileBuffer(this.path(path))
	}

	async writeFile(
		path: string,
		content: FileContent,
		options?: Parameters<BashMountableFs['writeFile']>[2],
	) {
		return super.writeFile(this.path(path), content, options)
	}

	async appendFile(
		path: string,
		content: FileContent,
		options?: Parameters<BashMountableFs['appendFile']>[2],
	) {
		return super.appendFile(this.path(path), content, options)
	}

	async exists(path: string) {
		return super.exists(this.path(path))
	}

	async stat(path: string): Promise<FsStat> {
		return super.stat(this.path(path))
	}

	async lstat(path: string): Promise<FsStat> {
		return super.lstat(this.path(path))
	}

	async mkdir(path: string, options?: MkdirOptions) {
		return super.mkdir(this.path(path), options)
	}

	async createExclusive(path: string, options: CreateExclusiveOptions) {
		return super.createExclusive(this.path(path), options)
	}

	mkdirSync(path: string, options?: MkdirOptions) {
		super.mkdirSync(this.path(path), options)
	}

	writeFileSync(path: string, content: string | Uint8Array) {
		super.writeFileSync(this.path(path), content)
	}

	async readdir(path: string) {
		return super.readdir(this.path(path))
	}

	async rm(path: string, options?: RmOptions) {
		this.assertUnmountedTree(path)
		return super.rm(this.path(path), options)
	}

	async cp(src: string, dest: string, options?: CpOptions) {
		return super.cp(this.path(src), this.path(dest), options)
	}

	async mv(src: string, dest: string) {
		this.assertUnmountedTree(src)
		this.assertUnmountedTree(dest)
		const owner = (path: string) => {
			const normalized = this.path(path)
			return this.getMounts().find(
				({ mountPoint }) =>
					normalized === mountPoint || normalized.startsWith(`${mountPoint}/`),
			)
		}
		// Copy-and-delete across mounts would bypass the source's rename policy.
		const source = owner(src)
		if (source?.filesystem !== owner(dest)?.filesystem)
			throw new Error('EXDEV: cannot move across filesystem mounts')
		if (source)
			return source.filesystem.mv(
				this.path(src).slice(source.mountPoint.length) || '/',
				this.path(dest).slice(source.mountPoint.length) || '/',
			)
		return super.mv(this.path(src), this.path(dest))
	}

	resolvePath(base: string, path: string) {
		return this.path(super.resolvePath(this.path(base || '/'), path))
	}

	async chmod(path: string, mode: number) {
		return super.chmod(this.path(path), mode)
	}

	async symlink(target: string, linkPath: string) {
		assertCanonicalVirtualPathCharacters(target)
		return super.symlink(target.normalize('NFC'), this.path(linkPath))
	}

	async link(existingPath: string, newPath: string) {
		return super.link(this.path(existingPath), this.path(newPath))
	}

	async readlink(path: string) {
		const target = await super.readlink(this.path(path))
		assertCanonicalVirtualPathCharacters(target)
		return target.normalize('NFC')
	}

	async realpath(path: string) {
		return this.path(await super.realpath(this.path(path)))
	}

	async utimes(path: string, atime: Date, mtime: Date) {
		return super.utimes(this.path(path), atime, mtime)
	}

	async readdirWithFileTypes(path: string) {
		const names = await this.readdir(path)
		return Promise.all(
			names.map(async (name) => {
				const stat = await this.lstat(this.resolvePath(path, name))
				return {
					name,
					isFile: stat.isFile,
					isDirectory: stat.isDirectory,
					isSymbolicLink: stat.isSymbolicLink,
				}
			}),
		)
	}
}
