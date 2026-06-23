import type { AIMessageContentPart } from '~/ai/core/types'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import {
	blobToDataUrl,
	cloneUserContextItem,
	getUserContextItemHash,
	type UserContextItem,
} from '~/ai/chat/context/user-context'
import { MAX_INLINE_FILE_BYTES } from '~/ai/chat/prompts'
import type { TextPart } from 'ai'

export interface PreparedUserContext {
	dedupedItems: UserContextItem[]
	imageParts: Extract<AIMessageContentPart, { type: 'image' }>[]
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
				runtime.pendingUserContext.some(
					(contextItem) =>
						contextItem.type === 'pending-context' &&
						contextItem.id === normalized.id,
				)
			) {
				return
			}
			runtime.pendingUserContext.push(normalized)
			this.notify()
			return
		}
		const hash = getUserContextItemHash(normalized)
		if (
			runtime.pendingUserContext.some(
				(contextItem) =>
					contextItem.type !== 'pending-context' && contextItem.hash === hash,
			)
		) {
			return
		}
		runtime.pendingUserContext.push(normalized)
		this.notify()
	}

	removeUserContext(index: number) {
		const session = this.getLoadedActiveSession()
		if (!session) return
		const runtime = this.runtimeStates.get(session.id)
		runtime.pendingUserContext.splice(index, 1)
		this.notify()
	}

	resolvePendingContextItem(id: string, replacement: UserContextItem | null) {
		const session = this.getLoadedActiveSession()
		if (!session) return
		const runtime = this.runtimeStates.get(session.id)
		const index = runtime.pendingUserContext.findIndex(
			(item) => item.type === 'pending-context' && item.id === id,
		)
		if (index === -1) return
		if (replacement === null) {
			runtime.pendingUserContext.splice(index, 1)
			this.notify()
			return
		}
		const normalized = cloneUserContextItem(replacement)
		const hash = getUserContextItemHash(normalized)
		const duplicateIndex = runtime.pendingUserContext.findIndex(
			(item, idx) =>
				idx !== index &&
				item.type !== 'pending-context' &&
				getUserContextItemHash(item) === hash,
		)
		if (duplicateIndex !== -1) {
			runtime.pendingUserContext.splice(index, 1)
		} else {
			runtime.pendingUserContext.splice(index, 1, normalized)
		}
		this.notify()
	}

	updateInputDraft(text: string) {
		const session = this.getLoadedActiveSession()
		if (!session) return
		const runtime = this.runtimeStates.get(session.id)
		runtime.pendingInputDraft = text
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

	async prepareUserContextForMessage(
		items: UserContextItem[],
	): Promise<PreparedUserContext> {
		const dedupedItems: UserContextItem[] = []
		const imageParts: Extract<AIMessageContentPart, { type: 'image' }>[] = []
		const seen = new Set<string>()
		for (const item of items) {
			if (item.type === 'pending-context') continue
			const hash = getUserContextItemHash(item)
			if (seen.has(hash)) {
				continue
			}
			seen.add(hash)
			if (item.type === 'image') {
				const imageBlob =
					item.blob.type === item.mimeType
						? item.blob
						: new Blob([item.blob], {
								type: item.mimeType,
							})
				const imageUrl = await blobToDataUrl(imageBlob)
				dedupedItems.push(cloneUserContextItem(item))
				imageParts.push({
					type: 'image',
					image: imageUrl,
				})
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
			imageParts,
		}
	}

	private getLoadedActiveSession() {
		return this.state.activeSessionId
			? this.state.loadedSessions.get(this.state.activeSessionId)
			: undefined
	}
}
