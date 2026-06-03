import { hash as hashObject } from 'ohash'

interface UserContextItemBase {
	hash: string
}

export interface FileContextItem extends UserContextItemBase {
	type: 'file'
	path: string
}

export interface FolderContextItem extends UserContextItemBase {
	type: 'folder'
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

export type UserContextItem =
	| FileContextItem
	| FolderContextItem
	| SelectedTextContextItem
	| ImageContextItem

export type NewSelectedTextContextItem = Omit<SelectedTextContextItem, 'hash'>

export function createFileContextItem(path: string): FileContextItem {
	return {
		hash: hashObject({ type: 'file', path }),
		type: 'file',
		path,
	}
}

export function createFolderContextItem(path: string): FolderContextItem {
	return {
		hash: hashObject({ type: 'folder', path }),
		type: 'folder',
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

export function getUserContextItemHash(item: UserContextItem): string {
	if (item.hash) return item.hash
	if (item.type === 'file') return hashObject({ type: 'file', path: item.path })
	if (item.type === 'folder') {
		return hashObject({ type: 'folder', path: item.path })
	}
	if (item.type === 'selection') {
		return hashObject({
			type: 'selection',
			filePath: item.filePath,
			range: item.range,
			selectedText: item.selectedText,
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
	const hash = getUserContextItemHash(item)
	if (item.type === 'file') return { ...item, hash }
	if (item.type === 'folder') return { ...item, hash }
	if (item.type === 'image') return { ...item, hash }
	return {
		...item,
		hash,
		range: {
			from: { ...item.range.from },
			to: { ...item.range.to },
		},
	}
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
// and downstream parsing harder. Image entries are skipped here on purpose:
// binary image content is already attached to the user message as `image_url`
// parts in ChatService, so duplicating image metadata in this text block is
// redundant and noisy.
export function formatUserContext(items: UserContextItem[]): string {
	const parts = items.reduce<Array<Record<string, unknown>>>((acc, item) => {
		if (item.type === 'file') {
			acc.push({ type: 'file', path: item.path })
		}
		if (item.type === 'folder') {
			acc.push({ type: 'folder', path: item.path })
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
