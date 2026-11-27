import { posix as pathPosix } from 'path-browserify'
import type {
	BufferEncoding,
	CpOptions,
	FileContent,
	IFileSystem,
	MkdirOptions,
	RmOptions,
} from 'just-bash/browser'
import type { ReversibleFileSnapshot } from '~/ai/chat/types'
import { encodeCompressedFileContent } from '~/ai/chat/messages/reversible-content'
import { encodeContent, isNotFoundError, type ReversibleOpRecorder } from './fs'
import { normalizeVirtualPath } from './virtual-path'

type Snapshot = ReversibleFileSnapshot | { kind: 'dir' }
type ReadOptions = Parameters<IFileSystem['readFile']>[1]
type WriteOptions = Parameters<IFileSystem['writeFile']>[2]

export interface ReversibleFsOptions {
	/**
	 * Virtual mount points whose paths must remain absolute in persisted
	 * reversible operations. All other paths are files in the Vault root and
	 * are recorded as Vault-relative paths.
	 */
	absoluteMountPoints?: readonly string[]
}

function joinPath(parent: string, child: string) {
	return parent === '/' ? `/${child}` : `${parent}/${child}`
}

export class ReversibleFs implements IFileSystem {
	private depth = 0

	constructor(
		private readonly inner: IFileSystem &
			Required<Pick<IFileSystem, 'readdirWithFileTypes'>> & {
				transformsWritesAt?: (path: string) => boolean
			},
		private readonly recorder: ReversibleOpRecorder,
		private readonly options: ReversibleFsOptions = {},
	) {}

	transformsWritesAt(path: string): boolean {
		return this.inner.transformsWritesAt?.(path) === true
	}

	private toRecordedPath(path: string) {
		const normalized = normalizeVirtualPath(path)
		if (!this.options.absoluteMountPoints) return normalized
		if (
			normalized === '/' ||
			this.options.absoluteMountPoints?.some(
				(mountPoint) =>
					normalized === mountPoint || normalized.startsWith(`${mountPoint}/`),
			)
		) {
			return normalized
		}
		return normalized.slice(1)
	}

	private createFileSnapshot(bytes: Uint8Array): ReversibleFileSnapshot {
		const { contentCompressed, compressedBytes } =
			encodeCompressedFileContent(bytes)
		const snapshot: ReversibleFileSnapshot = {
			kind: 'file',
			contentCompressed,
		}
		this.recorder.registerCompressedBytes(snapshot, compressedBytes)
		return snapshot
	}

	private async captureFileBefore(
		normalized: string,
		result: Map<string, Snapshot | undefined>,
	) {
		const recordedPath = this.toRecordedPath(normalized)
		if (this.recorder.hasInitial(recordedPath)) {
			// Keep the path in `before` so a subsequent removal/move still records
			// `after = undefined`, without re-reading and re-compressing bytes that
			// `recordVirtualTransition` would discard.
			result.set(normalized, this.recorder.getInitial(recordedPath))
			return
		}
		result.set(
			normalized,
			this.createFileSnapshot(await this.inner.readFileBuffer(normalized)),
		)
	}

	private recordTransitions(
		before: Map<string, Snapshot | undefined>,
		after: Map<string, Snapshot | undefined>,
	) {
		for (const path of new Set([...before.keys(), ...after.keys()])) {
			this.recorder.recordVirtualTransition(
				this.toRecordedPath(path),
				before.get(path),
				after.get(path),
			)
		}
	}

	private async snapshot(
		path: string,
		result = new Map<string, Snapshot | undefined>(),
		skipRecordedFiles = false,
	) {
		const normalized = normalizeVirtualPath(path)
		let stat: Awaited<ReturnType<IFileSystem['stat']>>
		try {
			stat = await this.inner.stat(normalized)
		} catch (error) {
			if (isNotFoundError(error)) return result
			throw error
		}
		if (stat.isDirectory) {
			result.set(normalized, { kind: 'dir' })
			for (const child of await this.inner.readdir(normalized)) {
				await this.snapshot(
					joinPath(normalized, child),
					result,
					skipRecordedFiles,
				)
			}
		} else if (skipRecordedFiles) {
			await this.captureFileBefore(normalized, result)
		} else {
			result.set(
				normalized,
				this.createFileSnapshot(await this.inner.readFileBuffer(normalized)),
			)
		}
		return result
	}

	private async mutate<T>(paths: string[], action: () => Promise<T>) {
		if (this.depth > 0) return action()
		this.depth++
		try {
			const before = new Map<string, Snapshot | undefined>()
			this.recorder.beginCapture()
			try {
				for (const path of paths) await this.snapshot(path, before, true)
			} finally {
				this.recorder.endCapture()
			}
			let result: T | undefined
			let failure: unknown
			let failed = false
			try {
				result = await action()
			} catch (error) {
				failed = true
				failure = error
			}
			const after = new Map<string, Snapshot | undefined>()
			this.recorder.beginCapture()
			try {
				for (const path of paths) await this.snapshot(path, after, false)
			} finally {
				this.recorder.endCapture()
			}
			this.recordTransitions(before, after)
			if (failed) throw failure
			return result as T
		} finally {
			this.depth--
		}
	}

	private async writePaths(path: string) {
		const paths = [normalizeVirtualPath(path)]
		let parent = pathPosix.dirname(paths[0])
		while (parent !== '/' && !(await this.inner.exists(parent))) {
			paths.push(parent)
			parent = pathPosix.dirname(parent)
		}
		return paths
	}

	readFile(path: string, options?: ReadOptions | BufferEncoding) {
		return this.inner.readFile(path, options)
	}

	readFileBuffer(path: string) {
		return this.inner.readFileBuffer(path)
	}

	async writeFile(
		path: string,
		content: FileContent,
		options?: WriteOptions | BufferEncoding,
	) {
		if (this.depth > 0) return this.inner.writeFile(path, content, options)
		const normalized = normalizeVirtualPath(path)
		if (this.inner.transformsWritesAt?.(normalized)) {
			return this.mutate(await this.writePaths(normalized), () =>
				this.inner.writeFile(path, content, options),
			)
		}
		this.depth++
		try {
			let existing: Awaited<ReturnType<IFileSystem['stat']>> | undefined
			let trackedPaths: string[]
			const before = new Map<string, Snapshot | undefined>()
			this.recorder.beginCapture()
			try {
				try {
					existing = await this.inner.stat(normalized)
				} catch (error) {
					if (!isNotFoundError(error)) throw error
				}
				if (existing && !existing.isDirectory) {
					trackedPaths = [normalized]
					await this.captureFileBefore(normalized, before)
				} else {
					trackedPaths = await this.writePaths(normalized)
					if (existing?.isDirectory) {
						await this.snapshot(normalized, before, true)
					}
				}
			} finally {
				this.recorder.endCapture()
			}
			let failure: unknown
			let failed = false
			try {
				await this.inner.writeFile(path, content, options)
			} catch (error) {
				failed = true
				failure = error
			}
			const after = new Map<string, Snapshot | undefined>()
			if (failed) {
				this.recorder.beginCapture()
				try {
					for (const tracked of trackedPaths) {
						await this.snapshot(tracked, after, false)
					}
				} finally {
					this.recorder.endCapture()
				}
			} else {
				// Verbatim-write filesystems persist the exact encoded bytes we
				// passed in, so we record the post-write snapshot directly without
				// another stat + readFileBuffer round trip.
				after.set(
					normalized,
					this.createFileSnapshot(encodeContent(content, options)),
				)
				for (let index = 1; index < trackedPaths.length; index += 1) {
					after.set(trackedPaths[index], { kind: 'dir' })
				}
			}
			this.recordTransitions(before, after)
			if (failed) throw failure
		} finally {
			this.depth--
		}
	}

	async appendFile(
		path: string,
		content: FileContent,
		options?: WriteOptions | BufferEncoding,
	) {
		return this.mutate(await this.writePaths(path), () =>
			this.inner.appendFile(path, content, options),
		)
	}

	exists(path: string) {
		return this.inner.exists(path)
	}
	stat(path: string) {
		return this.inner.stat(path)
	}
	lstat(path: string) {
		return this.inner.lstat?.(path) ?? this.inner.stat(path)
	}

	async mkdir(path: string, options?: MkdirOptions) {
		return this.mutate(await this.writePaths(path), () =>
			this.inner.mkdir(path, options),
		)
	}

	readdir(path: string) {
		return this.inner.readdir(path)
	}
	readdirWithFileTypes(path: string) {
		return this.inner.readdirWithFileTypes(path)
	}

	rm(path: string, options?: RmOptions) {
		return this.mutate([path], () => this.inner.rm(path, options))
	}

	async cp(src: string, dest: string, options?: CpOptions) {
		return this.mutate(await this.writePaths(dest), () =>
			this.inner.cp(src, dest, options),
		)
	}

	async mv(src: string, dest: string) {
		return this.mutate([src, ...(await this.writePaths(dest))], () =>
			this.inner.mv(src, dest),
		)
	}

	resolvePath(base: string, path: string) {
		return this.inner.resolvePath(base, path)
	}
	getAllPaths() {
		return this.inner.getAllPaths()
	}
	chmod(path: string, mode: number) {
		return this.inner.chmod(path, mode)
	}
	symlink(target: string, linkPath: string) {
		return this.mutate([linkPath], () => this.inner.symlink(target, linkPath))
	}
	link(existingPath: string, newPath: string) {
		return this.mutate([newPath], () => this.inner.link(existingPath, newPath))
	}
	readlink(path: string) {
		return this.inner.readlink(path)
	}
	realpath(path: string) {
		return this.inner.realpath(path)
	}
	utimes(path: string, atime: Date, mtime: Date) {
		return this.inner.utimes(path, atime, mtime)
	}
}
