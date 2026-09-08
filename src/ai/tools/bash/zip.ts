import { unzipSync, zipSync, type ZipOptions } from 'fflate/browser'
import {
	defineCommand,
	type CommandContext,
	type ExecResult,
} from 'just-bash/browser'
import { posix as pathPosix } from 'path-browserify'

interface ZipCommandOptions {
	archive?: string
	excludes: string[]
	inputs: string[]
	junkPaths: boolean
	level: number
	quiet: boolean
	readInputsFromStdin: boolean
	recursive: boolean
}

interface UnzipCommandOptions {
	archive?: string
	destination?: string
	excludes: string[]
	list: boolean
	memberPatterns: string[]
	neverOverwrite: boolean
	overwrite: boolean
	pipe: boolean
	quiet: boolean
	test: boolean
	verbose: boolean
}

interface ZipEntry {
	compressedSize: number
	compression: number
	flags: number
	mtime: Date
	name: string
	uncompressedSize: number
}

type ZipInput = Record<string, Uint8Array | [Uint8Array, ZipOptions]>

const ZIP_MIN_MTIME = new Date(1980, 0, 1)
const ZIP_MAX_MTIME = new Date(2099, 11, 31, 23, 59, 58)

function bytesToLatin1(bytes: Uint8Array) {
	const chunkSize = 0x8000
	let output = ''
	for (let index = 0; index < bytes.length; index += chunkSize) {
		output += String.fromCharCode(
			...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)),
		)
	}
	return output
}

function latin1ToBytes(value: string) {
	const bytes = new Uint8Array(value.length)
	for (let index = 0; index < value.length; index++) {
		bytes[index] = value.charCodeAt(index) & 0xff
	}
	return bytes
}

function decodeStdin(value: string) {
	return new TextDecoder().decode(latin1ToBytes(value))
}

function zipMtime(value: Date) {
	const timestamp = value.getTime()
	if (!Number.isFinite(timestamp)) return ZIP_MIN_MTIME
	return new Date(
		Math.min(
			Math.max(timestamp, ZIP_MIN_MTIME.getTime()),
			ZIP_MAX_MTIME.getTime(),
		),
	)
}

function commandError(command: string, message: string): ExecResult {
	return { stdout: '', stderr: `${command}: ${message}\n`, exitCode: 1 }
}

function commandHelp(command: 'zip' | 'unzip'): ExecResult {
	return command === 'zip'
		? {
				stdout:
					'usage: zip [-0-9jrq@] archive[.zip] file ... [-x pattern ...]\n',
				stderr: '',
				exitCode: 0,
			}
		: {
				stdout:
					'usage: unzip [-lptvnoq] archive[.zip] [member ...] [-x pattern ...] [-d directory]\n',
				stderr: '',
				exitCode: 0,
			}
}

function parseZipArgs(args: string[]): ZipCommandOptions | ExecResult {
	const options: ZipCommandOptions = {
		excludes: [],
		inputs: [],
		junkPaths: false,
		level: 6,
		quiet: false,
		readInputsFromStdin: false,
		recursive: false,
	}
	let parseOptions = true

	for (let index = 0; index < args.length; index++) {
		const argument = args[index]
		if (parseOptions && argument === '--') {
			parseOptions = false
			continue
		}
		if (parseOptions && (argument === '-h' || argument === '--help')) {
			return commandHelp('zip')
		}
		if (parseOptions && argument === '-x') {
			options.excludes.push(...args.slice(index + 1))
			break
		}
		if (parseOptions && argument === '-@') {
			options.readInputsFromStdin = true
			continue
		}
		if (parseOptions && argument.startsWith('-') && argument !== '-') {
			for (const flag of argument.slice(1)) {
				if (flag === 'r') options.recursive = true
				else if (flag === 'j') options.junkPaths = true
				else if (flag === 'q') options.quiet = true
				else if (/^[0-9]$/.test(flag)) options.level = Number(flag)
				else return commandError('zip', `unsupported option -${flag}`)
			}
			continue
		}
		if (!options.archive) {
			options.archive = argument
		} else {
			options.inputs.push(argument)
		}
	}

	if (!options.archive) {
		options.archive = '-'
		options.inputs.push('-')
	}
	if (options.archive === '-' && options.inputs.length === 0) {
		options.inputs.push('-')
	}
	return options
}

function parseUnzipArgs(args: string[]): UnzipCommandOptions | ExecResult {
	const options: UnzipCommandOptions = {
		excludes: [],
		list: false,
		memberPatterns: [],
		neverOverwrite: false,
		overwrite: false,
		pipe: false,
		quiet: false,
		test: false,
		verbose: false,
	}
	let parseOptions = true

	for (let index = 0; index < args.length; index++) {
		const argument = args[index]
		if (parseOptions && argument === '--') {
			parseOptions = false
			continue
		}
		if (parseOptions && (argument === '-h' || argument === '--help')) {
			return commandHelp('unzip')
		}
		if (parseOptions && argument === '-x') {
			options.excludes.push(...args.slice(index + 1))
			break
		}
		if (parseOptions && (argument === '-d' || argument.startsWith('-d'))) {
			const destination = argument === '-d' ? args[++index] : argument.slice(2)
			if (!destination)
				return commandError('unzip', 'option -d requires a directory')
			options.destination = destination
			continue
		}
		if (parseOptions && argument.startsWith('-') && argument !== '-') {
			for (const flag of argument.slice(1)) {
				if (flag === 'l') options.list = true
				else if (flag === 'v') options.verbose = true
				else if (flag === 'p' || flag === 'c') options.pipe = true
				else if (flag === 't') options.test = true
				else if (flag === 'n') options.neverOverwrite = true
				else if (flag === 'o') options.overwrite = true
				else if (flag === 'q') options.quiet = true
				else return commandError('unzip', `unsupported option -${flag}`)
			}
			continue
		}
		if (!options.archive) {
			options.archive = argument
		} else {
			options.memberPatterns.push(argument)
		}
	}

	if (!options.archive) return commandHelp('unzip')
	if (options.neverOverwrite && options.overwrite) {
		return commandError('unzip', 'options -n and -o cannot be used together')
	}
	return options
}

function globMatches(name: string, pattern: string) {
	let expression = '^'
	for (let index = 0; index < pattern.length; index++) {
		const character = pattern[index]
		if (character === '*') expression += '.*'
		else if (character === '?') expression += '.'
		else if (character === '[') {
			const end = pattern.indexOf(']', index + 1)
			if (end === -1) expression += '\\['
			else {
				const range = pattern.slice(index + 1, end)
				expression += `[${range.startsWith('!') ? `^${range.slice(1)}` : range}]`
				index = end
			}
		} else {
			expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
		}
	}
	return new RegExp(`${expression}$`).test(name)
}

function matchesMember(
	name: string,
	memberPatterns: string[],
	excludes: string[],
) {
	return (
		(memberPatterns.length === 0 ||
			memberPatterns.some((pattern) => globMatches(name, pattern))) &&
		!excludes.some((pattern) => globMatches(name, pattern))
	)
}

function archivePath(ctx: CommandContext, name: string) {
	if (name === '-') return '-'
	const resolved = ctx.fs.resolvePath(ctx.cwd, name)
	if (pathPosix.extname(resolved)) return resolved
	return `${resolved}.zip`
}

function entryNameForPath(cwd: string, absolutePath: string) {
	const relative = pathPosix.relative(cwd, absolutePath)
	if (relative && !relative.startsWith('../') && relative !== '..') {
		return relative
	}
	return absolutePath.replace(/^\/+/, '')
}

function safeEntryPath(destination: string, entryName: string) {
	const pathParts = entryName.split('/')
	if (
		entryName.startsWith('/') ||
		entryName.includes('\\') ||
		pathParts.some(
			(part, index) =>
				part === '..' || (part === '' && index !== pathParts.length - 1),
		)
	) {
		throw new Error(`unsafe archive entry: ${entryName}`)
	}
	const target = pathPosix.resolve(destination, entryName)
	if (target !== destination && !target.startsWith(`${destination}/`)) {
		throw new Error(`unsafe archive entry: ${entryName}`)
	}
	return target
}

function dateFromZipFields(date: number, time: number) {
	const year = 1980 + (date >> 9)
	const month = (date >> 5) & 0xf
	const day = date & 0x1f
	const hour = time >> 11
	const minute = (time >> 5) & 0x3f
	const second = (time & 0x1f) * 2
	return new Date(
		year,
		Math.max(0, month - 1),
		Math.max(1, day),
		hour,
		minute,
		second,
	)
}

function readZipEntries(bytes: Uint8Array): ZipEntry[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const minimumEocdOffset = Math.max(0, bytes.length - 0x10016)
	let eocdOffset = -1
	for (let offset = bytes.length - 22; offset >= minimumEocdOffset; offset--) {
		if (view.getUint32(offset, true) === 0x06054b50) {
			eocdOffset = offset
			break
		}
	}
	if (eocdOffset === -1)
		throw new Error('End-of-central-directory signature not found')

	const entryCount = view.getUint16(eocdOffset + 10, true)
	const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true)
	if (entryCount === 0xffff || centralDirectoryOffset === 0xffffffff) {
		throw new Error('Zip64 archives are not supported')
	}

	const entries: ZipEntry[] = []
	let offset = centralDirectoryOffset
	for (let index = 0; index < entryCount; index++) {
		if (
			offset + 46 > bytes.length ||
			view.getUint32(offset, true) !== 0x02014b50
		) {
			throw new Error('Invalid central directory entry')
		}
		const compressedSize = view.getUint32(offset + 20, true)
		const uncompressedSize = view.getUint32(offset + 24, true)
		const nameLength = view.getUint16(offset + 28, true)
		const extraLength = view.getUint16(offset + 30, true)
		const commentLength = view.getUint16(offset + 32, true)
		const end = offset + 46 + nameLength + extraLength + commentLength
		if (end > bytes.length)
			throw new Error('Invalid central directory entry length')
		const name = new TextDecoder().decode(
			bytes.subarray(offset + 46, offset + 46 + nameLength),
		)
		entries.push({
			compressedSize,
			compression: view.getUint16(offset + 10, true),
			flags: view.getUint16(offset + 8, true),
			mtime: dateFromZipFields(
				view.getUint16(offset + 14, true),
				view.getUint16(offset + 12, true),
			),
			name,
			uncompressedSize,
		})
		offset = end
	}
	return entries
}

async function collectPath(
	ctx: CommandContext,
	absolutePath: string,
	entryName: string,
	options: ZipCommandOptions,
	entries: ZipInput,
	archive: string,
) {
	if (absolutePath === archive) return
	const stat = await ctx.fs.stat(absolutePath)
	if (stat.isDirectory) {
		if (!options.junkPaths && entryName) {
			const directoryEntry = entryName.endsWith('/')
				? entryName
				: `${entryName}/`
			if (
				!options.excludes.some((pattern) =>
					globMatches(directoryEntry, pattern),
				)
			) {
				entries[directoryEntry] = [
					new Uint8Array(),
					{ mtime: zipMtime(stat.mtime) },
				]
			}
		}
		if (!options.recursive) return
		for (const child of await ctx.fs.readdir(absolutePath)) {
			const childPath = ctx.fs.resolvePath(absolutePath, child)
			const childEntry = entryName ? `${entryName}/${child}` : child
			await collectPath(ctx, childPath, childEntry, options, entries, archive)
		}
		return
	}

	const name = options.junkPaths ? pathPosix.basename(entryName) : entryName
	if (!name || options.excludes.some((pattern) => globMatches(name, pattern))) {
		return
	}
	entries[name] = [
		await ctx.fs.readFileBuffer(absolutePath),
		{ mtime: zipMtime(stat.mtime) },
	]
}

async function createZip(
	args: string[],
	ctx: CommandContext,
): Promise<ExecResult> {
	const options = parseZipArgs(args)
	if ('exitCode' in options) return options
	const archiveName = options.archive
	if (!archiveName) return commandHelp('zip')

	try {
		const archive = archivePath(ctx, archiveName)
		const entries: ZipInput = {}
		if (archive !== '-' && (await ctx.fs.exists(archive))) {
			Object.assign(entries, unzipSync(await ctx.fs.readFileBuffer(archive)))
		}

		const inputs = [...options.inputs]
		if (options.readInputsFromStdin) {
			inputs.push(
				...decodeStdin(ctx.stdin as unknown as string)
					.split(/\r?\n/)
					.filter(Boolean),
			)
		}
		if (inputs.length === 0) return commandError('zip', 'Nothing to do!')

		for (const input of inputs) {
			if (input === '-') {
				entries['-'] = latin1ToBytes(ctx.stdin as unknown as string)
				continue
			}
			const inputPath = ctx.fs.resolvePath(ctx.cwd, input)
			await collectPath(
				ctx,
				inputPath,
				entryNameForPath(ctx.cwd, inputPath),
				options,
				entries,
				archive,
			)
		}

		if (Object.keys(entries).length === 0) {
			return commandError('zip', 'Nothing to do!')
		}
		const archiveBytes = zipSync(entries, {
			level: options.level as ZipOptions['level'],
		})
		if (archive === '-') {
			return {
				stdout: bytesToLatin1(archiveBytes),
				stderr: '',
				exitCode: 0,
				stdoutKind: 'bytes',
			}
		}
		await ctx.fs.writeFile(archive, archiveBytes)
		return {
			stdout: options.quiet
				? ''
				: Object.keys(entries)
						.sort()
						.map((name) => `  adding: ${name} (deflated 0%)\n`)
						.join(''),
			stderr: '',
			exitCode: 0,
		}
	} catch (error) {
		return commandError(
			'zip',
			error instanceof Error ? error.message : String(error),
		)
	}
}

function unzipList(archive: string, entries: ZipEntry[], verbose: boolean) {
	const lines = [
		`Archive:  ${archive}`,
		verbose ? '  Length   Method      Size  Name' : '  Length      Name',
	]
	let total = 0
	for (const entry of entries) {
		total += entry.uncompressedSize
		lines.push(
			verbose
				? `${String(entry.uncompressedSize).padStart(8)}  ${entry.compression === 0 ? 'Stored ' : 'Defl:N'}  ${String(entry.compressedSize).padStart(8)}  ${entry.name}`
				: `${String(entry.uncompressedSize).padStart(8)}  ${entry.name}`,
		)
	}
	lines.push(`---------                     -------`)
	lines.push(
		`${String(total).padStart(8)}                     ${entries.length} files`,
	)
	return `${lines.join('\n')}\n`
}

function assertSupportedEntries(entries: ZipEntry[]) {
	for (const entry of entries) {
		if (entry.flags & 1) {
			throw new Error(`encrypted entry is not supported: ${entry.name}`)
		}
		if (entry.compression !== 0 && entry.compression !== 8) {
			throw new Error(`unsupported compression method for ${entry.name}`)
		}
	}
}

async function extractZip(
	args: string[],
	ctx: CommandContext,
): Promise<ExecResult> {
	const options = parseUnzipArgs(args)
	if ('exitCode' in options) return options
	const archiveName = options.archive
	if (!archiveName) return commandHelp('unzip')

	try {
		const archive = archivePath(ctx, archiveName)
		const archiveBytes =
			archive === '-'
				? latin1ToBytes(ctx.stdin as unknown as string)
				: await ctx.fs.readFileBuffer(archive)
		const allEntries = readZipEntries(archiveBytes)
		const entries = allEntries.filter((entry) =>
			matchesMember(entry.name, options.memberPatterns, options.excludes),
		)
		if (entries.length === 0) {
			return commandError('unzip', 'caution: filename not matched')
		}
		if (options.list || options.verbose) {
			return {
				stdout: unzipList(archiveName, entries, options.verbose),
				stderr: '',
				exitCode: 0,
			}
		}

		assertSupportedEntries(entries)
		const maxOutputSize = ctx.limits?.maxOutputSize ?? 0
		const totalSize = entries.reduce(
			(total, entry) => total + entry.uncompressedSize,
			0,
		)
		if (maxOutputSize > 0 && totalSize > maxOutputSize) {
			return commandError(
				'unzip',
				`decompressed data exceeds limit (${maxOutputSize} bytes)`,
			)
		}
		const selected = new Set(entries.map((entry) => entry.name))
		const files = unzipSync(archiveBytes, {
			filter: (file) => selected.has(file.name),
		})

		if (options.test) {
			return {
				stdout: options.quiet
					? ''
					: `${entries.map((entry) => `    testing: ${entry.name}   OK`).join('\n')}\nNo errors detected in compressed data.\n`,
				stderr: '',
				exitCode: 0,
			}
		}
		if (options.pipe) {
			const output = entries
				.filter((entry) => !entry.name.endsWith('/'))
				.map((entry) => files[entry.name])
				.filter((file) => file !== undefined)
				.map(bytesToLatin1)
				.join('')
			return { stdout: output, stderr: '', exitCode: 0, stdoutKind: 'bytes' }
		}

		const destination = ctx.fs.resolvePath(ctx.cwd, options.destination ?? '.')
		const targets = entries.map((entry) => ({
			entry,
			target: safeEntryPath(destination, entry.name),
		}))
		if (!options.overwrite && !options.neverOverwrite) {
			for (const { entry, target } of targets) {
				if (!entry.name.endsWith('/') && (await ctx.fs.exists(target))) {
					return commandError(
						'unzip',
						`replace ${target}? Use -o to overwrite or -n to skip existing files`,
					)
				}
			}
		}

		const output: string[] = []
		for (const { entry, target } of targets) {
			if (entry.name.endsWith('/')) {
				await ctx.fs.mkdir(target, { recursive: true })
				continue
			}
			if (options.neverOverwrite && (await ctx.fs.exists(target))) {
				if (!options.quiet) output.push(`  skipping: ${entry.name}`)
				continue
			}
			const data = files[entry.name]
			if (!data)
				return commandError('unzip', `missing archive entry: ${entry.name}`)
			await ctx.fs.writeFile(target, data)
			await ctx.fs.utimes(target, entry.mtime, entry.mtime)
			if (!options.quiet) output.push(` extracting: ${entry.name}`)
		}
		return {
			stdout: output.length ? `${output.join('\n')}\n` : '',
			stderr: '',
			exitCode: 0,
		}
	} catch (error) {
		return commandError(
			'unzip',
			error instanceof Error ? error.message : String(error),
		)
	}
}

export const archiveCommands = [
	defineCommand('zip', createZip),
	defineCommand('unzip', extractZip),
]
