import type { IFileSystem } from 'just-bash/browser'
import { z } from 'zod/mini'

const path = z.string().check(
	z.minLength(1),
	z.maxLength(4096),
	z.refine((value) => !value.includes('\0')),
)
const content = z.union([
	z.string().check(z.maxLength(4_194_304)),
	z.custom<Uint8Array>(
		(value) =>
			ArrayBuffer.isView(value) &&
			Object.prototype.toString.call(value) === '[object Uint8Array]' &&
			value.byteLength <= 4_194_304,
	),
])
const recursive = z.optional(z.object({ recursive: z.optional(z.boolean()) }))
const encodingValue = z.enum([
	'utf8',
	'utf-8',
	'base64',
	'hex',
	'binary',
	'latin1',
])
const encoding = z.optional(
	z.union([encodingValue, z.object({ encoding: z.optional(encodingValue) })]),
)
const schemas = {
	exists: z.tuple([path]),
	stat: z.tuple([path]),
	readdir: z.tuple([path]),
	readFile: z.tuple([path, encoding]),
	readFileBuffer: z.tuple([path]),
	writeFile: z.tuple([path, content, encoding]),
	appendFile: z.tuple([path, content, encoding]),
	mkdir: z.tuple([path, recursive]),
	rm: z.tuple([
		path,
		z.optional(
			z.object({
				recursive: z.optional(z.boolean()),
				force: z.optional(z.boolean()),
			}),
		),
	]),
	mv: z.tuple([path, path]),
	cp: z.tuple([path, path, recursive]),
	resolvePath: z.tuple([path, path]),
}
/** Input types and runtime validation share one contract; results retain Agent VFS types. */
export type AppFS = {
	[K in keyof typeof schemas]: (
		...args: z.input<(typeof schemas)[K]>
	) => Promise<Awaited<ReturnType<IFileSystem[K]>>>
}
export const appFSMethods = Object.keys(schemas) as (keyof AppFS)[]
const reads = new Set([
	'exists',
	'stat',
	'readdir',
	'readFile',
	'readFileBuffer',
	'resolvePath',
])

/** Validate untrusted arguments before dispatch, and serialize mutations per runtime. */
export function createAppFSDispatcher(
	filesystem: () => Promise<IFileSystem>,
	check: () => void,
	readonly = false,
) {
	let queue: Promise<unknown> = Promise.resolve()
	let instance: Promise<IFileSystem> | undefined
	return (method: string, args: unknown[]): Promise<unknown> => {
		const run = async () => {
			check()
			if (!Object.hasOwn(schemas, method))
				throw new Error('Unknown filesystem operation')
			const key = method as keyof typeof schemas
			const parsed = schemas[key].parse(args)
			if (readonly && !reads.has(key))
				throw new Error(
					'Filesystem writes are unavailable during startup validation; write in response to user actions',
				)
			const fs = await (instance ??= filesystem())
			check()
			// eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply supplies the original filesystem receiver.
			const result: unknown = await Reflect.apply(fs[key], fs, parsed)
			check()
			return result
		}
		const result = queue.catch(() => {}).then(run)
		queue = result
		return result
	}
}

/** Serialized into the sandbox; keep this factory self-contained and browser-only. */
export function createAppFS(
	rpc: (method: string, ...args: unknown[]) => Promise<unknown>,
	methods: string[],
): AppFS {
	return Object.freeze(
		Object.fromEntries(
			methods.map((method) => [
				method,
				(...args: unknown[]) => rpc(`fs.${method}`, ...args),
			]),
		),
	) as unknown as AppFS
}
