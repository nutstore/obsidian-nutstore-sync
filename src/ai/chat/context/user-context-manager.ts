import type { ChatState } from '~/ai/chat/runtime/chat-state'
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import {
	cloneUserContextItem,
	formatUserContext,
	getUserContextItemHash,
	type UserContextItem,
} from '~/ai/chat/context/user-context'
import { toImageFilePart } from '~/ai/chat/messages/message-utils'
import { MAX_INLINE_FILE_BYTES } from '~/ai/chat/prompts'
import type { FilePart, TextPart } from 'ai'

export interface PreparedUserContext {
	dedupedItems: UserContextItem[]
}

export class UserContextManager {
	constructor(
		private state: ChatState,
		private runtimeStates: RuntimeStates,
		private notify: () => void,
	) {}

	addUserContext(item: UserContextItem) {
		const session = this.getLoadedActiveSession()
		if (!session) return
		const runtime = this.runtimeStates.get(session.id)
		const normalized = cloneUserContextItem(item)
		if (normalized.type === 'pending-context') {
			if (
				runtime.draft.userContext.some(
					(contextItem) =>
						contextItem.type === 'pending-context' &&
						contextItem.id === normalized.id,
				)
			) {
				return
			}
			runtime.draft.userContext.push(normalized)
			this.notify()
			return
		}
		const hash = getUserContextItemHash(normalized)
		if (
			runtime.draft.userContext.some(
				(contextItem) =>
					contextItem.type !== 'pending-context' && contextItem.hash === hash,
			)
		) {
			return
		}
		runtime.draft.userContext.push(normalized)
		this.notify()
	}

	removeUserContext(index: number) {
		const session = this.getLoadedActiveSession()
		if (!session) return
		const runtime = this.runtimeStates.get(session.id)
		runtime.draft.userContext.splice(index, 1)
		this.notify()
	}

	resolvePendingContextItem(id: string, replacement: UserContextItem | null) {
		const session = this.getLoadedActiveSession()
		if (!session) return
		const runtime = this.runtimeStates.get(session.id)
		const index = runtime.draft.userContext.findIndex(
			(item) => item.type === 'pending-context' && item.id === id,
		)
		if (index === -1) return
		if (replacement === null) {
			runtime.draft.userContext.splice(index, 1)
			this.notify()
			return
		}
		const normalized = cloneUserContextItem(replacement)
		const hash = getUserContextItemHash(normalized)
		const duplicateIndex = runtime.draft.userContext.findIndex(
			(item, idx) =>
				idx !== index &&
				item.type !== 'pending-context' &&
				getUserContextItemHash(item) === hash,
		)
		if (duplicateIndex !== -1) {
			runtime.draft.userContext.splice(index, 1)
		} else {
			runtime.draft.userContext.splice(index, 1, normalized)
		}
		this.notify()
	}

	updateInputDraft(text: string) {
		const session = this.getLoadedActiveSession()
		if (!session) return
		const runtime = this.runtimeStates.get(session.id)
		runtime.draft.text = text
	}

	dedupeUserContextItems(items: UserContextItem[]): UserContextItem[] {
		const deduped: UserContextItem[] = []
		const seen = new Set<string>()
		for (const item of items) {
			if (item.type === 'pending-context') continue
			const hash = getUserContextItemHash(item)
			if (seen.has(hash)) {
				continue
			}
			seen.add(hash)
			deduped.push(cloneUserContextItem(item))
		}
		return deduped
	}

	async createTextFileContextPart(
		item: Extract<UserContextItem, { type: 'file' }>,
	): Promise<TextPart> {
		const truncated = item.size > MAX_INLINE_FILE_BYTES
		const blob = truncated
			? item.blob.slice(0, MAX_INLINE_FILE_BYTES)
			: item.blob
		const content = await blob.text()
		const payload = {
			type: 'file',
			filename: item.filename,
			mimeType: item.mimeType,
			size: item.size,
			truncated,
			content,
		}
		return {
			type: 'text',
			text: `<UserProvidedFile>\n${JSON.stringify(payload, null, 2)}\n</UserProvidedFile>`,
		}
	}

	async createImageFilePart(
		item: Extract<UserContextItem, { type: 'image' }>,
	): Promise<FilePart> {
		const imageBlob =
			item.blob.type === item.mimeType
				? item.blob
				: new Blob([item.blob], {
						type: item.mimeType,
					})
		const arrayBuffer = await imageBlob.arrayBuffer()
		return toImageFilePart(new Uint8Array(arrayBuffer), {
			mediaType: item.mimeType,
			filename: item.name,
		})
	}

	async buildMessagePartsFromUserContext(
		items: UserContextItem[],
	): Promise<Array<TextPart | FilePart>> {
		const parts: Array<TextPart | FilePart> = []
		const dedupedItems = this.dedupeUserContextItems(items)
		const pathAndSelectionContext = dedupedItems.filter(
			(contextItem) =>
				contextItem.type === 'vault-path' || contextItem.type === 'selection',
		)
		if (pathAndSelectionContext.length) {
			parts.push({
				type: 'text',
				text: formatUserContext(pathAndSelectionContext),
			})
		}
		for (const item of dedupedItems) {
			if (item.type === 'image') {
				parts.push(await this.createImageFilePart(item))
				continue
			}
			if (item.type === 'file') {
				parts.push(await this.createTextFileContextPart(item))
			}
		}
		return parts
	}

	async prepareUserContextForMessage(
		items: UserContextItem[],
	): Promise<PreparedUserContext> {
		const dedupedItems: UserContextItem[] = []
		const seen = new Set<string>()
		for (const item of items) {
			if (item.type === 'pending-context') continue
			const hash = getUserContextItemHash(item)
			if (seen.has(hash)) {
				continue
			}
			seen.add(hash)
			if (item.type === 'image') {
				dedupedItems.push(cloneUserContextItem(item))
				continue
			}
			if (item.type === 'file') {
				dedupedItems.push(cloneUserContextItem(item))
				continue
			}
			dedupedItems.push(cloneUserContextItem(item))
		}
		return {
			dedupedItems,
		}
	}

	private getLoadedActiveSession() {
		return this.state.activeSessionId
			? this.state.loadedSessions.get(this.state.activeSessionId)
			: undefined
	}
}
