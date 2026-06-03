import { deflateSync as deflate, inflateSync as inflate } from 'fflate/browser'
import { toUint8Array } from 'js-base64'
import type {
	ReversibleCompressedContent,
	ReversibleFileSnapshot,
} from '../components/solid-js'

function toArrayBuffer(content: Uint8Array) {
	return content.buffer.slice(
		content.byteOffset,
		content.byteOffset + content.byteLength,
	) as ArrayBuffer
}

export function createCompressedFileContent(
	content: ArrayBuffer | Uint8Array | string,
): ReversibleCompressedContent {
	const bytes =
		typeof content === 'string'
			? new TextEncoder().encode(content)
			: content instanceof Uint8Array
				? content
				: new Uint8Array(content)
	const compressed = deflate(bytes, { level: 9 })
	return {
		compress: 'deflate',
		blob: new Blob([toArrayBuffer(compressed)], {
			type: 'application/octet-stream',
		}),
	}
}

export function hasCompressedFileContent(
	content: ReversibleFileSnapshot,
): content is ReversibleFileSnapshot & {
	contentCompressed: ReversibleCompressedContent
} {
	return (
		content.contentCompressed?.compress === 'deflate' &&
		content.contentCompressed.blob instanceof Blob
	)
}

export async function decodeReversibleFileSnapshot(
	content: ReversibleFileSnapshot,
) {
	if (hasCompressedFileContent(content)) {
		const compressed = await content.contentCompressed.blob.arrayBuffer()
		const inflated = inflate(new Uint8Array(compressed))
		return toArrayBuffer(inflated)
	}
	const bytes = toUint8Array(content.contentBase64 || '')
	return toArrayBuffer(bytes)
}
