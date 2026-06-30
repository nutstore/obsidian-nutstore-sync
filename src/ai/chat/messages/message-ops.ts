import { Notice } from 'obsidian'
import type { AIMessageRecord, AISession } from '~/ai/core/types'
import type { AssistantModelMessage, ToolCallPart } from 'ai'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import { messageToText } from '~/ai/chat/messages/message-utils'
import {
	getParentVaultPaths,
	getPathDepth,
	isVaultFile,
	isVaultFolder,
	normalizeReversibleToolOpRecord,
} from '~/ai/chat/messages/reversible-op-utils'
import { decodeReversibleFileSnapshot } from '~/ai/chat/messages/reversible-content'
import { cloneUserContextItems } from '~/ai/chat/context/user-context'
import {
	captureWorkspaceContexts,
	computeChangedContexts,
} from '~/ai/chat/context/workspace-context'
import type { MessageFactory } from '~/ai/chat/messages/message-factory'
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { RecallMessageResult } from '~/ai/chat/ui/types'
import logger from '~/utils/logger'
import type NutstorePlugin from '../../..'

export class MessageOps {
	constructor(
		private plugin: NutstorePlugin,
		private state: ChatState,
		private runtimeStates: RuntimeStates,
		private store: SessionStore,
		private notify: () => void,
		private messageFactory: MessageFactory,
		private validateSelection: (session: AISession) => boolean,
		private requestRun: (sessionId: string) => Promise<void> | void,
	) {}

	deleteMessage(messageId: string) {
		const session = this.getLoadedActiveSession()
		if (!session) {
			return
		}
		const runtime = this.runtimeStates.get(session.id)
		if (runtime.runState !== 'idle') {
			return
		}
		const fragment = this.messageFactory.getActiveFragment(session)
		const idx = fragment.messages.findIndex((record) => record.id === messageId)
		if (idx === -1) {
			return
		}
		const target = fragment.messages[idx]
		if (target.message.role === 'user') {
			let endIdx = idx + 1
			while (
				endIdx < fragment.messages.length &&
				fragment.messages[endIdx].message.role !== 'user'
			) {
				endIdx++
			}
			fragment.messages.splice(idx, endIdx - idx)
		} else if (target.message.role === 'tool') {
			const firstPart = Array.isArray(target.message.content)
				? (
						target.message.content as Array<{
							type: string
							toolCallId?: string
						}>
					)[0]
				: undefined
			const toolCallId =
				firstPart?.type === 'tool-result' ? firstPart.toolCallId : undefined
			for (let i = idx - 1; i >= 0; i--) {
				const record = fragment.messages[i]
				if (record.message.role === 'user') break
				if (
					record.message.role === 'assistant' &&
					Array.isArray(record.message.content)
				) {
					const content = record.message.content as Array<
						{ type: string } & Partial<ToolCallPart>
					>
					if (
						content.some(
							(p) => p.type === 'tool-call' && p.toolCallId === toolCallId,
						)
					) {
						record.message = {
							...record.message,
							content: content.filter(
								(p) => !(p.type === 'tool-call' && p.toolCallId === toolCallId),
							),
						} as AssistantModelMessage
						break
					}
				}
			}
			fragment.messages.splice(idx, 1)
		} else {
			fragment.messages.splice(idx, 1)
		}
		void this.store.persistSession(session)
		this.notify()
	}

	async recallMessage(
		messageId: string,
		options?: { restoreFiles?: boolean },
	): Promise<RecallMessageResult | void> {
		const session = this.getLoadedActiveSession()
		if (!session) {
			return
		}
		const runtime = this.runtimeStates.get(session.id)
		if (runtime.runState !== 'idle') {
			return
		}
		const fragment = this.messageFactory.getActiveFragment(session)
		const idx = fragment.messages.findIndex((record) => record.id === messageId)
		if (idx === -1) {
			return
		}
		const recalledMessage = fragment.messages[idx]
		const recalledText =
			recalledMessage.message.role === 'user'
				? messageToText(recalledMessage.message)
				: ''
		const recalledUserContext = cloneUserContextItems(
			recalledMessage.userContext ?? [],
		)
		const recallRange = fragment.messages.slice(idx)
		const reversibleOps = recallRange.flatMap(
			(record) => record.reversibleOps ?? [],
		)
		try {
			if (options?.restoreFiles) {
				await this.restoreFilesForRecall(reversibleOps)
			}
			fragment.messages.splice(idx)
			runtime.draft.userContext = recalledUserContext
			runtime.draft.text = recalledText
			await this.store.persistSession(session)
			this.notify()
			return {
				text: recalledText,
				userContext: cloneUserContextItems(recalledUserContext),
			}
		} catch (error) {
			logger.error(error)
			new Notice(error instanceof Error ? error.message : String(error))
		}
	}

	recallMessageHasReversibleOps(messageId: string): boolean {
		const session = this.getLoadedActiveSession()
		if (!session) {
			return false
		}
		const fragment = this.messageFactory.getActiveFragment(session)
		const idx = fragment.messages.findIndex((record) => record.id === messageId)
		if (idx === -1) {
			return false
		}
		return fragment.messages
			.slice(idx)
			.some((record) => Boolean(record.reversibleOps?.length))
	}

	async regenerateMessage(messageId: string) {
		const session = this.getLoadedActiveSession()
		if (!session || !this.validateSelection(session)) {
			return
		}
		const runtime = this.runtimeStates.get(session.id)
		if (runtime.runState !== 'idle' || runtime.processing) {
			return
		}
		const fragment = this.messageFactory.getActiveFragment(session)
		const idx = fragment.messages.findIndex((record) => record.id === messageId)
		if (idx === -1) {
			return
		}
		const messagesAfter = fragment.messages.slice(idx + 1)
		fragment.messages = fragment.messages.slice(0, idx)

		const lastUserIdx = fragment.messages.findLastIndex(
			(r) => r.message.role === 'user',
		)
		if (lastUserIdx !== -1) {
			const prevMessages = fragment.messages.slice(0, lastUserIdx)
			const current = captureWorkspaceContexts(this.plugin.app)
			const changed = computeChangedContexts(prevMessages, current)
			fragment.messages[lastUserIdx].workspaceContextDelta =
				changed.length > 0 ? changed : undefined
		}

		runtime.runState = 'thinking'
		await this.store.persistSession(session)
		this.notify()
		await this.requestRun(session.id)
		if (messagesAfter.length > 0) {
			const updatedFragment = this.messageFactory.getActiveFragment(session)
			updatedFragment.messages = [...updatedFragment.messages, ...messagesAfter]
			await this.store.persistSession(session)
			this.notify()
		}
	}

	async restoreFilesForRecall(
		operations: NonNullable<AIMessageRecord['reversibleOps']>,
	) {
		const normalizedOperations = operations
			.map(normalizeReversibleToolOpRecord)
			.filter(
				(op): op is NonNullable<AIMessageRecord['reversibleOps']>[number] =>
					!!op,
			)
		if (normalizedOperations.length === 0) {
			return
		}

		const earliestByPath = new Map<
			string,
			(typeof normalizedOperations)[number]
		>()
		for (const operation of normalizedOperations) {
			if (!earliestByPath.has(operation.vaultPath)) {
				earliestByPath.set(operation.vaultPath, operation)
			}
		}

		const deletePaths = new Set<string>()
		const restoreDirs = new Set<string>()
		const restoreFiles = new Map<
			string,
			Extract<
				NonNullable<AIMessageRecord['reversibleOps']>[number],
				{ operation: 'update' }
			>['before']
		>()

		for (const operation of earliestByPath.values()) {
			if (operation.operation === 'create') {
				deletePaths.add(operation.vaultPath)
				continue
			}
			if (operation.operation === 'update') {
				restoreFiles.set(operation.vaultPath, operation.before)
				continue
			}
			if (operation.before.kind === 'dir') {
				restoreDirs.add(operation.vaultPath)
				continue
			}
			restoreFiles.set(operation.vaultPath, operation.before)
		}

		logger.info(
			`Recall restore start: ${normalizedOperations.length} recorded ops, ` +
				`${deletePaths.size} deletes, ${restoreDirs.size} directories, ${restoreFiles.size} files.`,
		)

		for (const path of [...deletePaths].sort((left, right) => {
			const depthDelta = getPathDepth(right) - getPathDepth(left)
			return depthDelta !== 0 ? depthDelta : left.localeCompare(right)
		})) {
			await this.deleteVaultPathIfExists(path)
		}

		const requiredDirs = new Set<string>(restoreDirs)
		for (const filePath of restoreFiles.keys()) {
			for (const parentPath of getParentVaultPaths(filePath)) {
				requiredDirs.add(parentPath)
			}
		}

		for (const path of [...requiredDirs].sort((left, right) => {
			const depthDelta = getPathDepth(left) - getPathDepth(right)
			return depthDelta !== 0 ? depthDelta : left.localeCompare(right)
		})) {
			await this.ensureVaultDirectory(path)
		}

		for (const filePath of [...restoreFiles.keys()].sort((left, right) => {
			const depthDelta = getPathDepth(left) - getPathDepth(right)
			return depthDelta !== 0 ? depthDelta : left.localeCompare(right)
		})) {
			const snapshot = restoreFiles.get(filePath)
			if (snapshot) {
				await this.writeVaultFile(filePath, snapshot)
			}
		}

		logger.info('Recall restore completed.')
	}

	private async deleteVaultPathIfExists(path: string) {
		const target = this.plugin.app.vault.getAbstractFileByPath(path)
		if (!target) {
			return
		}
		if (isVaultFolder(target) && target.children.length > 0) {
			logger.info(`Recall restore skip non-empty dir: ${path}`)
			return
		}
		logger.info(`Recall restore delete: ${path}`)
		if (typeof this.plugin.app.vault.delete === 'function') {
			await this.plugin.app.vault.delete(target, true)
			return
		}
		if (typeof this.plugin.app.vault.trash === 'function') {
			await this.plugin.app.vault.trash(target, false)
			return
		}
		throw new Error(`Unable to delete ${path}: vault delete is unavailable.`)
	}

	private async ensureVaultDirectory(path: string) {
		if (!path) {
			return
		}
		const target = this.plugin.app.vault.getAbstractFileByPath(path)
		if (target) {
			if (isVaultFolder(target)) {
				return
			}
			throw new Error(`Unable to restore ${path}: a file already exists there.`)
		}
		logger.info(`Recall restore mkdir: ${path}`)
		await this.plugin.app.vault.createFolder(path)
	}

	private async writeVaultFile(
		path: string,
		content: Extract<
			NonNullable<AIMessageRecord['reversibleOps']>[number],
			{ operation: 'update' }
		>['before'],
	) {
		const data = await decodeReversibleFileSnapshot(content)
		const existing = this.plugin.app.vault.getAbstractFileByPath(path)
		if (existing && isVaultFolder(existing)) {
			throw new Error(
				`Unable to restore ${path}: a directory already exists there.`,
			)
		}
		if (existing && isVaultFile(existing)) {
			logger.info(`Recall restore write: ${path} (overwrite)`)
			await this.plugin.app.vault.modifyBinary(existing as never, data)
			return
		}
		logger.info(`Recall restore write: ${path} (create)`)
		await this.plugin.app.vault.createBinary(path, data)
	}

	private getLoadedActiveSession() {
		return this.state.activeSessionId
			? this.state.loadedSessions.get(this.state.activeSessionId)
			: undefined
	}
}
