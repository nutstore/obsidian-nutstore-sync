import { deflateSync as deflate, inflateSync as inflate } from 'fflate/browser'
import { toUint8Array } from 'js-base64'
import type {
	ReversibleCompressedContent,
	ReversibleFileSnapshot,
} from '~/ai/chat/types'

function toArrayBuffer(content: Uint8Array) {
	return content.buffer.slice(
		content.byteOffset,
		content.byteOffset + content.byteLength,
	) as ArrayBuffer
}

/**
 * Level 1 raw deflate runs synchronously on the main thread during file edits:
 * text and JSON snapshots already compress to nearly the same size as level 9,
 * while avoiding deep LZ77 hash-chain stalls on mobile WebViews.
 */
const SNAPSHOT_DEFLATE_LEVEL = 1

export function encodeCompressedFileContent(
	content: ArrayBuffer | Uint8Array | string,
): {
	contentCompressed: ReversibleCompressedContent
	compressedBytes: Uint8Array
} {
	const bytes =
		typeof content === 'string'
			? new TextEncoder().encode(content)
			: content instanceof Uint8Array
				? content
				: new Uint8Array(content)
	const compressedBytes = deflate(bytes, { level: SNAPSHOT_DEFLATE_LEVEL })
	return {
		contentCompressed: {
			compress: 'deflate',
			blob: new Blob([toArrayBuffer(compressedBytes)], {
				type: 'application/octet-stream',
			}),
		},
		compressedBytes,
	}
}

export function createCompressedFileContent(
	content: ArrayBuffer | Uint8Array | string,
): ReversibleCompressedContent {
	return encodeCompressedFileContent(content).contentCompressed
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
