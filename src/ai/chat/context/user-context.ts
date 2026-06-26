import { hash as hashObject } from 'ohash'

interface UserContextItemBase {
	hash: string
}

export interface VaultPathContextItem extends UserContextItemBase {
	type: 'vault-path'
	kind: 'file' | 'folder'
	path: string
}

export interface SelectedTextContextItem extends UserContextItemBase {
	type: 'selection'
	filePath: string
	range: {
		from: { line: number; ch: number }
		to: { line: number; ch: number }
	}
	selectedText: string
}

export interface ImageContextItem extends UserContextItemBase {
	type: 'image'
	blob: Blob
	mimeType: string
	name?: string
	size: number
}

export interface FileContextItem extends UserContextItemBase {
	type: 'file'
	blob: Blob
	mimeType: string
	filename: string
	size: number
}

export interface PendingContextItem {
	type: 'pending-context'
	/** Eventual target context type, e.g. 'image' | 'video' | 'audio' | 'file'. */
	placeholderType: string
	/** Correlation id used to resolve this placeholder into a real item. */
	id: string
	/** Optional display label for the chip while loading. */
	placeholder?: string
}

export type UserContextItem =
	| VaultPathContextItem
	| SelectedTextContextItem
	| ImageContextItem
	| FileContextItem
	| PendingContextItem

export type NewSelectedTextContextItem = Omit<SelectedTextContextItem, 'hash'>

export function createVaultPathContextItem(
	path: string,
	kind: 'file' | 'folder',
): VaultPathContextItem {
	return {
		hash: hashObject({ type: 'vault-path', kind, path }),
		type: 'vault-path',
		kind,
		path,
	}
}

export function createSelectedTextContextItem(
	item: NewSelectedTextContextItem,
): SelectedTextContextItem {
	return {
		...item,
		range: {
			from: { ...item.range.from },
			to: { ...item.range.to },
		},
		hash: hashObject(item),
	}
}

export async function createImageContextItem(
	blob: Blob,
	options?: { mimeType?: string; name?: string; size?: number },
): Promise<ImageContextItem> {
	const mimeType = options?.mimeType || blob.type || 'image/png'
	const size = options?.size ?? blob.size
	const imageBlob =
		blob.type === mimeType
			? blob
			: new Blob([blob], {
					type: mimeType,
				})
	const dataUrl = await blobToDataUrl(imageBlob)
	return {
		hash: hashObject({
			type: 'image',
			mimeType,
			size,
			dataUrl,
		}),
		type: 'image',
		blob,
		mimeType,
		name: options?.name,
		size,
	}
}

export function createFileContextItem(
	blob: Blob,
	options: { mimeType?: string; filename: string; size?: number },
): FileContextItem {
	const mimeType = options.mimeType || blob.type || 'application/octet-stream'
	const size = options.size ?? blob.size
	const lastModified =
		'lastModified' in blob && typeof blob.lastModified === 'number'
			? blob.lastModified
			: undefined
	return {
		hash: hashObject({
			type: 'file',
			mimeType,
			filename: options.filename,
			size,
			lastModified,
		}),
		type: 'file',
		blob,
		mimeType,
		filename: options.filename,
		size,
	}
}

let pendingContextCounter = 0

export function createPendingContextItem(
	placeholderType: string,
	placeholder?: string,
): PendingContextItem {
	pendingContextCounter += 1
	const id = `pending-context-${Date.now().toString(36)}-${pendingContextCounter}`
	return {
		type: 'pending-context',
		placeholderType,
		id,
		placeholder,
	}
}

export function getUserContextItemHash(item: UserContextItem): string {
	if (item.type === 'pending-context') return item.id
	if (item.hash) return item.hash
	if (item.type === 'vault-path') {
		return hashObject({ type: 'vault-path', kind: item.kind, path: item.path })
	}
	if (item.type === 'selection') {
		return hashObject({
			type: 'selection',
			filePath: item.filePath,
			range: item.range,
			selectedText: item.selectedText,
		})
	}
	if (item.type === 'file') {
		return hashObject({
			type: 'file',
			mimeType: item.mimeType,
			filename: item.filename,
			size: item.size,
		})
	}
	return hashObject({
		type: 'image',
		mimeType: item.mimeType,
		size: item.size,
	})
}

export function ensureUserContextItemHash(
	item: UserContextItem,
): UserContextItem {
	if (item.type === 'pending-context') return { ...item }
	const hash = getUserContextItemHash(item)
	if (item.type === 'vault-path') return { ...item, hash }
	if (item.type === 'image') return { ...item, hash }
	if (item.type === 'file') return { ...item, hash }
	return {
		...item,
		hash,
		range: {
			from: { ...item.range.from },
			to: { ...item.range.to },
		},
	}
}

export function cloneUserContextItem(item: UserContextItem): UserContextItem {
	const normalized = ensureUserContextItemHash(item)
	if (normalized.type === 'vault-path') {
		return { ...normalized }
	}
	if (normalized.type === 'image') {
		return { ...normalized }
	}
	if (normalized.type === 'file') {
		return { ...normalized }
	}
	if (normalized.type === 'pending-context') {
		return { ...normalized }
	}
	return {
		hash: normalized.hash,
		type: 'selection',
		filePath: normalized.filePath,
		range: {
			from: { ...normalized.range.from },
			to: { ...normalized.range.to },
		},
		selectedText: normalized.selectedText,
	}
}

export function cloneUserContextItems(items: UserContextItem[]) {
	return items.map(cloneUserContextItem)
}

export function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const reader = new FileReader()
		reader.onerror = () => {
			reject(reader.error || new Error('Failed to read image blob.'))
		}
		reader.onload = () => {
			if (typeof reader.result === 'string') {
				resolve(reader.result)
				return
			}
			reject(new Error('Unexpected FileReader result while reading image.'))
		}
		reader.readAsDataURL(blob)
	})
}

// We intentionally serialize user context entries as JSON records wrapped by
// <UserProvidedContext> instead of generating per-item XML nodes. The previous
// XML shape (especially for image items) added little value and made escaping
// and downstream parsing harder. Binary entries (`image`, `file`) are skipped
// here on purpose because their payloads are attached elsewhere in ChatService.
export function formatUserContext(items: UserContextItem[]): string {
	const parts = items.reduce<Array<Record<string, unknown>>>((acc, item) => {
		if (item.type === 'vault-path') {
			acc.push({ type: item.kind, path: item.path })
		}
		if (item.type === 'selection') {
			acc.push({
				type: 'selection',
				filePath: item.filePath,
				range: {
					from: item.range.from,
					to: item.range.to,
				},
				selectedText: item.selectedText,
			})
		}
		return acc
	}, [])
	const json = JSON.stringify(parts, null, 2)
	return `<UserProvidedContext>\n${json}\n</UserProvidedContext>`
}
