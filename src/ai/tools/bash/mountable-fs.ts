import {
	MountableFs as BashMountableFs,
	type RmOptions,
} from 'just-bash/browser'
import { normalizeVirtualPath } from './fs'

/** Directory types follow the same mount routing and virtual parents as ordinary reads. */
export class MountableFs extends BashMountableFs {
	/** A base directory operation must never bypass a mounted filesystem's policy. */
	private assertUnmountedTree(path: string) {
		const normalized = normalizeVirtualPath(path)
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

	async rm(path: string, options?: RmOptions) {
		this.assertUnmountedTree(path)
		return super.rm(path, options)
	}

	async mv(src: string, dest: string) {
		this.assertUnmountedTree(src)
		this.assertUnmountedTree(dest)
		const owner = (path: string) => {
			const normalized = normalizeVirtualPath(path)
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
				normalizeVirtualPath(src).slice(source.mountPoint.length) || '/',
				normalizeVirtualPath(dest).slice(source.mountPoint.length) || '/',
			)
		return super.mv(src, dest)
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
