import { limitAsync } from 'es-toolkit'
import { fromUint8Array } from 'js-base64'
import type { ChatSession, LegacyChatSession } from '~/ai/chat/domain'

// V1 (IndexedDB era) kept binary payloads as ArrayBuffers, which IndexedDB
// stores natively but which cannot survive JSON.stringify (they degenerate into
// numeric-indexed objects). V2 encodes every binary payload as a base64url
// string so whole sessions can be persisted as plain JSON files. V1 marker
// records AND bare ArrayBuffer/ArrayBufferView values are still accepted on
// decode so legacy IndexedDB records can be decoded, migrated to the current
// session schema, and encoded directly as final JSON snapshots.
const BLOB_RECORD_MARKER_V1 = '__nutstore_chat_blob_v1'
const BLOB_RECORD_MARKER_V2 = '__nutstore_chat_blob_v2'
const URL_RECORD_MARKER = '__nutstore_chat_url_v1'
const BINARY_RECORD_MARKER_V2 = '__nutstore_chat_binary_v2'

interface PersistedBlobRecord {
	[BLOB_RECORD_MARKER_V2]: true
	type: string
	data: string
}

interface LegacyPersistedBlobRecord {
	[BLOB_RECORD_MARKER_V1]: true
	type: string
	data: ArrayBuffer
}

interface PersistedUrlRecord {
	[URL_RECORD_MARKER]: true
	href: string
}

/** Kinds emitted by current writes. Older V2 records may contain other views. */
type PersistedBinaryKind = 'arraybuffer' | 'Uint8Array'

interface PersistedBinaryRecord {
	[BINARY_RECORD_MARKER_V2]: true
	kind: string
	data: string
}

type WritablePersistedBinaryRecord = Omit<PersistedBinaryRecord, 'kind'> & {
	kind: PersistedBinaryKind
}

type LegacyViewConstructor = new (buffer: ArrayBuffer) => ArrayBufferView

const LEGACY_VIEW_CONSTRUCTORS: Record<string, LegacyViewConstructor> = {
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array,
	Float64Array,
}

if (typeof BigInt64Array !== 'undefined') {
	LEGACY_VIEW_CONSTRUCTORS.BigInt64Array = BigInt64Array
}
if (typeof BigUint64Array !== 'undefined') {
	LEGACY_VIEW_CONSTRUCTORS.BigUint64Array = BigUint64Array
}

type PersistedValue<T> = T extends Blob
	? PersistedBlobRecord
	: T extends URL
		? PersistedUrlRecord
		: T extends ArrayBuffer | Uint8Array
			? PersistedBinaryRecord
			: T extends readonly (infer Item)[]
				? PersistedValue<Item>[]
				: T extends object
					? { [Key in keyof T]: PersistedValue<T[Key]> }
					: T

export type PersistedChatSession = PersistedValue<
	ChatSession | LegacyChatSession
>

/**
 * Blobs are immutable; caching their base64url encoding weakly turns repeated
 * whole-session persists across long `apply_patch` conversations from O(k^2)
 * Blob reads into O(k).
 */
const encodedBlobCache = new WeakMap<Blob, string>()

function base64UrlToArrayBuffer(value: string): ArrayBuffer {
	const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
	const binary = atob(padded)
	const buffer = new ArrayBuffer(binary.length)
	const bytes = new Uint8Array(buffer)
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i)
	}
	return buffer
}

function createBinaryRecord(
	value: ArrayBuffer | Uint8Array,
): WritablePersistedBinaryRecord {
	if (value instanceof ArrayBuffer) {
		return {
			[BINARY_RECORD_MARKER_V2]: true,
			kind: 'arraybuffer',
			data: fromUint8Array(new Uint8Array(value), true),
		}
	}
	return {
		[BINARY_RECORD_MARKER_V2]: true,
		kind: 'Uint8Array',
		data: fromUint8Array(value, true),
	}
}

function isPersistedBlobRecord(value: unknown): value is PersistedBlobRecord {
	return (
		!!value &&
		typeof value === 'object' &&
		(value as Partial<PersistedBlobRecord>)[BLOB_RECORD_MARKER_V2] === true &&
		typeof (value as Partial<PersistedBlobRecord>).type === 'string' &&
		typeof (value as Partial<PersistedBlobRecord>).data === 'string'
	)
}

function isLegacyPersistedBlobRecord(
	value: unknown,
): value is LegacyPersistedBlobRecord {
	return (
		!!value &&
		typeof value === 'object' &&
		(value as Partial<LegacyPersistedBlobRecord>)[BLOB_RECORD_MARKER_V1] ===
			true &&
		typeof (value as Partial<LegacyPersistedBlobRecord>).type === 'string' &&
		(value as Partial<LegacyPersistedBlobRecord>).data instanceof ArrayBuffer
	)
}

function isPersistedBinaryRecord(
	value: unknown,
): value is PersistedBinaryRecord {
	return (
		!!value &&
		typeof value === 'object' &&
		(value as Partial<PersistedBinaryRecord>)[BINARY_RECORD_MARKER_V2] ===
			true &&
		typeof (value as Partial<PersistedBinaryRecord>).kind === 'string' &&
		typeof (value as Partial<PersistedBinaryRecord>).data === 'string'
	)
}

function isPersistedUrlRecord(value: unknown): value is PersistedUrlRecord {
	return (
		!!value &&
		typeof value === 'object' &&
		(value as Partial<PersistedUrlRecord>)[URL_RECORD_MARKER] === true &&
		typeof (value as Partial<PersistedUrlRecord>).href === 'string'
	)
}

interface BlobEncoding {
	blob: Blob
	record: PersistedBlobRecord
}

/**
 * Clones the graph synchronously so later mutations cannot enter the snapshot,
 * while collecting Blob payloads for one bounded asynchronous pass.
 */
function encodeBlobs(value: unknown, blobs: BlobEncoding[]): unknown {
	if (value instanceof Blob) {
		const cached = encodedBlobCache.get(value)
		const record: PersistedBlobRecord = {
			[BLOB_RECORD_MARKER_V2]: true,
			type: value.type,
			data: cached ?? '',
		}
		if (cached === undefined) {
			blobs.push({ blob: value, record })
		}
		return record
	}
	if (value instanceof URL) {
		return {
			[URL_RECORD_MARKER]: true,
			href: value.href,
		} satisfies PersistedUrlRecord
	}
	if (value instanceof ArrayBuffer || value instanceof Uint8Array) {
		return createBinaryRecord(value)
	}
	if (ArrayBuffer.isView(value)) {
		throw new TypeError(
			'Only ArrayBuffer and Uint8Array are supported in chat session persistence',
		)
	}
	if (Array.isArray(value)) {
		return value.map((entry) => encodeBlobs(entry, blobs))
	}
	if (!value || typeof value !== 'object') {
		return value
	}

	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			encodeBlobs(entry, blobs),
		]),
	)
}

/** Blob reads are memory-heavy; keep only a few buffers alive at once. */
const encodeBlob = limitAsync(async ({ blob, record }: BlobEncoding) => {
	const encoded = fromUint8Array(new Uint8Array(await blob.arrayBuffer()), true)
	encodedBlobCache.set(blob, encoded)
	record.data = encoded
}, 3)

function decodeBinaryRecord(
	value: PersistedBinaryRecord,
): ArrayBuffer | ArrayBufferView {
	const buffer = base64UrlToArrayBuffer(value.data)
	if (value.kind === 'arraybuffer') {
		return buffer
	}
	if (value.kind === 'dataview') {
		return new DataView(buffer)
	}
	if (value.kind === 'Buffer' && typeof Buffer !== 'undefined') {
		return Buffer.from(buffer)
	}
	const viewCtor = LEGACY_VIEW_CONSTRUCTORS[value.kind]
	if (viewCtor) {
		try {
			return new viewCtor(buffer)
		} catch {
			/* Preserve the bytes when a legacy view constructor is unavailable. */
		}
	}
	return buffer
}

/**
 * Decodes in place on the freshly parsed snapshot. `JSON.parse` already
 * produced a private graph, so replacing records in their parents avoids a
 * second copy of the whole session.
 */
function decodeBlobs(value: unknown): unknown {
	if (isPersistedBlobRecord(value)) {
		const blob = new Blob([base64UrlToArrayBuffer(value.data)], {
			type: value.type,
		})
		if (/^[A-Za-z0-9_-]*$/.test(value.data)) {
			encodedBlobCache.set(blob, value.data)
		}
		return blob
	}
	if (isLegacyPersistedBlobRecord(value)) {
		return new Blob([value.data], { type: value.type })
	}
	if (isPersistedBinaryRecord(value)) {
		return decodeBinaryRecord(value)
	}
	if (isPersistedUrlRecord(value)) {
		return new URL(value.href)
	}
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			value[index] = decodeBlobs(value[index])
		}
		return value
	}
	if (
		!value ||
		typeof value !== 'object' ||
		value instanceof Blob ||
		value instanceof ArrayBuffer ||
		ArrayBuffer.isView(value)
	) {
		return value
	}

	const record = value as Record<string, unknown>
	for (const key of Object.keys(record)) {
		const entry = decodeBlobs(record[key])
		if (key === '__proto__') {
			Object.defineProperty(record, key, {
				value: entry,
				writable: true,
				enumerable: true,
				configurable: true,
			})
		} else {
			record[key] = entry
		}
	}
	return record
}

/**
 * A whole ChatSession is persisted as a plain JSON file. Nested Blob/File
 * values, ArrayBuffers and Uint8Arrays cannot survive JSON.stringify, so
 * every binary payload is base64url-encoded and restored at the session
 * boundary instead. V1 records are still accepted on decode for lossless
 * migration from IndexedDB storage.
 */
export async function encodeChatSessionForStorage(
	session: ChatSession,
): Promise<PersistedChatSession> {
	const blobs: BlobEncoding[] = []
	const snapshot = encodeBlobs(session, blobs)
	await Promise.all(blobs.map(encodeBlob))
	return snapshot as PersistedChatSession
}

/**
 * Restores binary values in place. The input snapshot is consumed: callers must
 * not reuse it after decoding.
 */
export function decodeChatSessionFromStorage(
	stored: PersistedChatSession,
): ChatSession | LegacyChatSession {
	return decodeBlobs(stored) as ChatSession | LegacyChatSession
}
