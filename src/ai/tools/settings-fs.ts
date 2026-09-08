import type {
	BufferEncoding,
	CpOptions,
	FileContent,
	FsStat,
	IFileSystem,
	MkdirOptions,
	RmOptions,
} from 'just-bash/browser'
import { posix as pathPosix } from 'path-browserify'
import type { NutstoreSettings } from '~/settings'
import type { PermissionGuard } from './permission-guard'
import { encodeContent, toArrayBuffer } from './bash/fs'
import { SETTINGS_MOUNT_POINT } from './bash/mount-points'
import {
	describeSettingsPatch,
	getChangedSettingsPatch,
	type NormalizedSettingsPatch,
	parseSettingsWhitelistJson,
	serializeSettingsWhitelist,
} from './settings-whitelist'

type ReadFileOptions = Parameters<IFileSystem['readFile']>[1]
type WriteFileOptions = Parameters<IFileSystem['writeFile']>[2]

const FILE_MODE = 0o644
const DIR_MODE = 0o755

export interface SettingsInput {
	getSettings: () => NutstoreSettings
	updateSettings: (patch: NormalizedSettingsPatch) => Promise<void>
	permissionGuard?: PermissionGuard
	onRead?: (virtualPath: string) => void
}

function normalizeVirtualPath(inputPath: string) {
	const normalized = pathPosix.normalize(pathPosix.resolve('/', inputPath))
	return normalized === '' ? '/' : normalized
}

function joinVirtualPath(parent: string, name: string) {
	return parent === '/' ? `/${name}` : `${parent}/${name}`
}

function toRelativePath(path: string) {
	const normalized = normalizeVirtualPath(path)
	if (normalized === '/') {
		return ''
	}
	return normalized.slice(1)
}

function settingsError(code: string, message: string): never {
	const error = new Error(`${code}: ${message}`) as Error & { code: string }
	error.code = code
	throw error
}

/**
 * A virtual (mountable) filesystem exposing a whitelist of plugin settings as
 * a single JSON file. Reads serialize the live settings; writes are validated,
 * gate a permission request, and persist back to plugin settings via the
 * provided updater. No real file exists on disk.
 */
export class SettingsFs implements IFileSystem {
	private static readonly FILE = 'settings.json'
	private lastWriteMtime = new Date()

	constructor(private readonly input: SettingsInput) {}

	private isFileRoot(path: string) {
		return toRelativePath(path) === SettingsFs.FILE
	}

	private isDirectoryRoot(path: string) {
		return toRelativePath(path) === ''
	}

	private missing(path: string): never {
		settingsError('ENOENT', `no such file or directory, access '${path}'`)
	}

	private noOpOnPath(path: string): never {
		settingsError(
			'EROFS',
			`settings file is virtual and cannot be modified this way: '${path}'`,
		)
	}

	private serialized() {
		return serializeSettingsWhitelist(this.input.getSettings())
	}

	private async readText(path: string) {
		if (!this.isFileRoot(path)) {
			this.missing(path)
		}
		return this.serialized()
	}

	async readFile(
		path: string,
		_options?: ReadFileOptions | BufferEncoding,
	): Promise<string> {
		return this.readText(path).then((text) => {
			this.input.onRead?.(
				joinVirtualPath(SETTINGS_MOUNT_POINT, SettingsFs.FILE),
			)
			return text
		})
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		const text = await this.readText(path)
		this.input.onRead?.(joinVirtualPath(SETTINGS_MOUNT_POINT, SettingsFs.FILE))
		return new TextEncoder().encode(text)
	}

	async writeFile(
		path: string,
		content: FileContent,
		options?: WriteFileOptions | BufferEncoding,
	): Promise<void> {
		if (!this.isFileRoot(path)) {
			this.missing(path)
		}
		const text = new TextDecoder('utf-8').decode(
			toArrayBuffer(encodeContent(content, options)),
		)
		const parsed = parseSettingsWhitelistJson(text)
		if (!parsed.ok) {
			throw new Error(`EINVAL: ${parsed.error}`)
		}
		const changes = getChangedSettingsPatch(
			this.input.getSettings(),
			parsed.patch,
		)
		await this.input.permissionGuard?.({
			type: 'settings',
			settings: {
				action: 'update',
				summary: describeSettingsPatch(changes).join('\n') || '',
				changes,
			},
		})
		await this.input.updateSettings(changes)
		this.lastWriteMtime = new Date()
	}

	async appendFile(
		path: string,
		_content: FileContent,
		_options?: WriteFileOptions | BufferEncoding,
	): Promise<void> {
		if (!this.isFileRoot(path)) {
			this.missing(path)
		}
		this.noOpOnPath(path)
	}

	async exists(path: string): Promise<boolean> {
		const relative = toRelativePath(path)
		return relative === '' || relative === SettingsFs.FILE
	}

	async stat(path: string): Promise<FsStat> {
		const relative = toRelativePath(path)
		if (relative === '') {
			return {
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
				mode: DIR_MODE,
				size: 0,
				mtime: new Date(0),
			}
		}
		if (relative === SettingsFs.FILE) {
			const size = new TextEncoder().encode(this.serialized()).byteLength
			return {
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false,
				mode: FILE_MODE,
				size,
				mtime: this.lastWriteMtime,
			}
		}
		this.missing(path)
	}

	async lstat(path: string): Promise<FsStat> {
		return this.stat(path)
	}

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		const relative = toRelativePath(path)
		if (relative === '') {
			return
		}
		if (options?.recursive && !(await this.exists(path))) {
			this.noOpOnPath(path)
		}
		settingsError('EEXIST', `file already exists, mkdir '${path}'`)
	}

	async readdir(path: string): Promise<string[]> {
		if (!this.isDirectoryRoot(path)) {
			this.missing(path)
		}
		return [SettingsFs.FILE]
	}

	async readdirWithFileTypes(path: string) {
		if (!this.isDirectoryRoot(path)) {
			this.missing(path)
		}
		return [
			{
				name: SettingsFs.FILE,
				isFile: true,
				isDirectory: false,
				isSymbolicLink: false,
			},
		]
	}

	async rm(path: string, _options?: RmOptions): Promise<void> {
		if (!(await this.exists(path))) {
			this.missing(path)
		}
		this.noOpOnPath(path)
	}

	async cp(_src: string, dest: string, _options?: CpOptions): Promise<void> {
		this.noOpOnPath(dest)
	}

	async mv(_src: string, dest: string): Promise<void> {
		this.noOpOnPath(dest)
	}

	resolvePath(base: string, path: string): string {
		return normalizeVirtualPath(pathPosix.resolve(base || '/', path))
	}

	getAllPaths(): string[] {
		return ['/', `/${SettingsFs.FILE}`]
	}

	async chmod(path: string, _mode: number): Promise<void> {
		if (!(await this.exists(path))) {
			this.missing(path)
		}
	}

	async symlink(_target: string, linkPath: string): Promise<void> {
		this.noOpOnPath(linkPath)
	}

	async link(_existingPath: string, newPath: string): Promise<void> {
		this.noOpOnPath(newPath)
	}

	async readlink(path: string): Promise<string> {
		this.missing(path)
	}

	async realpath(path: string): Promise<string> {
		if (!(await this.exists(path))) {
			this.missing(path)
		}
		return normalizeVirtualPath(path)
	}

	async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
		if (!(await this.exists(path))) {
			this.missing(path)
		}
		if (this.isFileRoot(path)) {
			this.lastWriteMtime = mtime
		}
	}
}
