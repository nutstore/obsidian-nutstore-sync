import type { ChatSession, LegacyChatSession } from '~/ai/chat/domain'

const BLOB_RECORD_MARKER = '__nutstore_chat_blob_v1'
const URL_RECORD_MARKER = '__nutstore_chat_url_v1'

interface PersistedBlobRecord {
	[BLOB_RECORD_MARKER]: true
	type: string
	data: ArrayBuffer
}

interface PersistedUrlRecord {
	[URL_RECORD_MARKER]: true
	href: string
}

type PersistedValue<T> = T extends Blob
	? PersistedBlobRecord
	: T extends URL
		? PersistedUrlRecord
		: T extends ArrayBuffer | ArrayBufferView
			? T
			: T extends readonly (infer Item)[]
				? PersistedValue<Item>[]
				: T extends object
					? { [Key in keyof T]: PersistedValue<T[Key]> }
					: T

export type PersistedChatSession = PersistedValue<
	ChatSession | LegacyChatSession
>

function copyArrayBufferView(view: ArrayBufferView): ArrayBufferView {
	const bytes = new Uint8Array(view.byteLength)
	bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
	if (view instanceof DataView) {
		return new DataView(bytes.buffer)
	}
	const View = view.constructor as new (buffer: ArrayBuffer) => ArrayBufferView
	return new View(bytes.buffer)
}

function isPersistedBlobRecord(value: unknown): value is PersistedBlobRecord {
	return (
		!!value &&
		typeof value === 'object' &&
		(value as Partial<PersistedBlobRecord>)[BLOB_RECORD_MARKER] === true &&
		typeof (value as Partial<PersistedBlobRecord>).type === 'string' &&
		(value as Partial<PersistedBlobRecord>).data instanceof ArrayBuffer
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

async function encodeBlobs(value: unknown): Promise<unknown> {
	if (value instanceof Blob) {
		return {
			[BLOB_RECORD_MARKER]: true,
			type: value.type,
			data: await value.arrayBuffer(),
		} satisfies PersistedBlobRecord
	}
	if (value instanceof URL) {
		return {
			[URL_RECORD_MARKER]: true,
			href: value.href,
		} satisfies PersistedUrlRecord
	}
	if (Array.isArray(value)) {
		return Promise.all(value.map(encodeBlobs))
	}
	if (!value || typeof value !== 'object') {
		return value
	}
	if (value instanceof ArrayBuffer) {
		return value.slice(0)
	}
	if (ArrayBuffer.isView(value)) {
		return copyArrayBufferView(value)
	}

	const entries = await Promise.all(
		Object.entries(value).map(async ([key, entry]) => [
			key,
			await encodeBlobs(entry),
		]),
	)
	return Object.fromEntries(entries)
}

function decodeBlobs(value: unknown): unknown {
	if (isPersistedBlobRecord(value)) {
		return new Blob([value.data], { type: value.type })
	}
	if (isPersistedUrlRecord(value)) {
		return new URL(value.href)
	}
	if (Array.isArray(value)) {
		return value.map(decodeBlobs)
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
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [key, decodeBlobs(entry)]),
	)
}

/**
 * WebKit can reject nested Blob/File values when a containing object is put in
 * IndexedDB. Store blobs as ArrayBuffer-backed records and restore them at the
 * session boundary instead.
 */
export async function encodeChatSessionForStorage(
	session: ChatSession,
): Promise<PersistedChatSession> {
	return (await encodeBlobs(session)) as PersistedChatSession
}

export function decodeChatSessionFromStorage(
	stored: PersistedChatSession,
): ChatSession | LegacyChatSession {
	return decodeBlobs(stored) as ChatSession | LegacyChatSession
}
