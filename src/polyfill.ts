// This module initializes the plugin's WebView realm. Tests provide a window
// explicitly instead of making the production runtime depend on Node globals.
import { Gunzip, Inflate, Unzlib } from 'fflate'

interface ProcessLike {
	cwd: () => string
	env?: Record<string, string | undefined>
}

type RuntimeWindow = Window & {
	process?: ProcessLike
	TransformStream?: typeof TransformStream
	DecompressionStream?: typeof DecompressionStream
}

const runtimeGlobal = window as RuntimeWindow

const processLike: ProcessLike = runtimeGlobal.process ?? {
	cwd() {
		return '/'
	},
	env: {},
}

if (typeof processLike.cwd !== 'function') {
	processLike.cwd = () => '/'
}

if (!processLike.env || typeof processLike.env !== 'object') {
	processLike.env = {}
}

runtimeGlobal.process = processLike

if (typeof runtimeGlobal.queueMicrotask !== 'function') {
	const resolvedPromise = Promise.resolve()
	runtimeGlobal.queueMicrotask = (callback: VoidFunction): void => {
		if (typeof callback !== 'function') {
			throw new TypeError('queueMicrotask callback must be a function')
		}

		void resolvedPromise.then(callback).catch((error: unknown) => {
			const reportedError =
				error instanceof Error ? error : new Error(String(error))
			runtimeGlobal.setTimeout(() => {
				throw reportedError
			}, 0)
		})
	}
}

/**
 * Bundled dependencies (file-type ZIP sniffing via just-bash, jose) construct
 * `DecompressionStream('deflate-raw')`, which needs Chrome 103 / iOS 16.4,
 * newer than our runtime targets. Fill only the missing formats with fflate
 * and keep native streams for formats the WebView already supports. Without
 * TransformStream there is no stream substrate to fill, so nothing changes.
 */
type DecompressionFormat = 'deflate' | 'deflate-raw' | 'gzip'

const decompressors: Record<
	DecompressionFormat,
	new (ondata: (chunk: Uint8Array, final: boolean) => void) => {
		push(chunk: Uint8Array, final?: boolean): void
	}
> = { deflate: Unzlib, 'deflate-raw': Inflate, gzip: Gunzip }

function supportsNativeFormat(
	Native: typeof DecompressionStream | undefined,
	format: DecompressionFormat,
) {
	if (typeof Native !== 'function') return false
	try {
		new Native(format)
		return true
	} catch {
		return false
	}
}

const NativeDecompressionStream = runtimeGlobal.DecompressionStream
const missingFormats = (
	Object.keys(decompressors) as DecompressionFormat[]
).filter((format) => !supportsNativeFormat(NativeDecompressionStream, format))

/** A TransformStream already satisfies the DecompressionStream interface. */
function createFflateDecompressionStream(
	format: DecompressionFormat,
	Transform: typeof TransformStream,
): TransformStream<BufferSource, Uint8Array> {
	let controller!: TransformStreamDefaultController<Uint8Array>
	const decompressor = new decompressors[format]((chunk) => {
		controller.enqueue(chunk)
	})
	const toBytes = (chunk: BufferSource) =>
		ArrayBuffer.isView(chunk)
			? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
			: new Uint8Array(chunk)
	return new Transform<BufferSource, Uint8Array>({
		start(transformController) {
			controller = transformController
		},
		transform(chunk) {
			decompressor.push(toBytes(chunk))
		},
		flush() {
			decompressor.push(new Uint8Array(0), true)
		},
	})
}

const Transform = runtimeGlobal.TransformStream
if (missingFormats.length > 0 && typeof Transform === 'function') {
	runtimeGlobal.DecompressionStream = function DecompressionStream(
		format: DecompressionFormat,
	) {
		if (!(format in decompressors))
			throw new TypeError(`Unsupported compression format: ${String(format)}`)
		if (NativeDecompressionStream && !missingFormats.includes(format))
			return new NativeDecompressionStream(format)
		return createFflateDecompressionStream(format, Transform)
	} as unknown as typeof DecompressionStream
}

export {}
