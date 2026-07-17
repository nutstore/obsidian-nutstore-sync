import type { ChatSession } from '~/ai/chat/domain'
import type { ReversibleToolOp } from '~/ai/chat/types'
import { Notice } from 'obsidian'
import type { ChatState } from '~/ai/chat/runtime/chat-state'
import {
	getMessageText,
	getUserContextItems,
} from '~/ai/chat/messages/ui-message'
import {
	getParentVaultPaths,
	getPathDepth,
	isVaultFile,
	isVaultFolder,
	normalizeReversibleToolOpRecord,
} from '~/ai/chat/messages/reversible-op-utils'
import { decodeReversibleFileSnapshot } from '~/ai/chat/messages/reversible-content'
import { copyUserContextItems } from '~/ai/chat/context/user-context'
import {
	captureWorkspaceContexts,
	computeChangedContexts,
} from '~/ai/chat/context/workspace-context'
import type { MessageFactory } from '~/ai/chat/messages/message-factory'
import type { RuntimeStates } from '~/ai/chat/runtime/runtime-state'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { RecallMessageResult } from '~/ai/chat/ui/types'
import logger from '~/utils/logger'
import type { SkillRepository } from '~/ai/skills/repository'
import type NutstorePlugin from '../../..'

export class MessageOps {
	constructor(
		private plugin: NutstorePlugin,
		private state: ChatState,
		private runtimeStates: RuntimeStates,
		private store: SessionStore,
		private notify: () => void,
		private messageFactory: MessageFactory,
		private validateSelection: (session: ChatSession) => boolean,
		private requestRun: (sessionId: string) => Promise<void> | void,
		private skillRepository?: SkillRepository,
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
		const agent = this.messageFactory.getActiveAgent(session)
		const idx = agent.timeline.findIndex((message) => message.id === messageId)
		if (idx === -1) {
			return
		}
		const target = agent.timeline[idx]
		if (target.role === 'user') {
			let endIdx = idx + 1
			while (
				endIdx < agent.timeline.length &&
				agent.timeline[endIdx].role !== 'user'
			) {
				endIdx++
			}
			for (const removed of agent.timeline.splice(idx, endIdx - idx)) {
				delete agent.operations[removed.id]
			}
		} else {
			agent.timeline.splice(idx, 1)
			delete agent.operations[target.id]
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
		const agent = this.messageFactory.getActiveAgent(session)
		const idx = agent.timeline.findIndex((message) => message.id === messageId)
		if (idx === -1) {
			return
		}
		const recalledMessage = agent.timeline[idx]
		const recalledText =
			recalledMessage.role === 'user' ? getMessageText(recalledMessage) : ''
		const recalledUserContext = copyUserContextItems(
			getUserContextItems(recalledMessage),
		)
		const recallRange = agent.timeline.slice(idx)
		const reversibleOps = recallRange.flatMap(
			(message) => agent.operations[message.id] ?? [],
		)
		try {
			if (options?.restoreFiles) {
				await this.restoreFilesForRecall(reversibleOps)
			}
			for (const removed of agent.timeline.splice(idx)) {
				delete agent.operations[removed.id]
			}
			runtime.draft.userContext = recalledUserContext
			runtime.draft.text = recalledText
			await this.store.persistSession(session)
			this.notify()
			return {
				text: recalledText,
				userContext: copyUserContextItems(recalledUserContext),
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
		const agent = this.messageFactory.getActiveAgent(session)
		const idx = agent.timeline.findIndex((message) => message.id === messageId)
		if (idx === -1) {
			return false
		}
		return agent.timeline
			.slice(idx)
			.some((message) => Boolean(agent.operations[message.id]?.length))
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
		const agent = this.messageFactory.getActiveAgent(session)
		const idx = agent.timeline.findIndex((message) => message.id === messageId)
		if (idx === -1) {
			return
		}
		const messagesAfter = agent.timeline.slice(idx + 1)
		agent.timeline = agent.timeline.slice(0, idx)

		const lastUserIdx = agent.timeline.findLastIndex(
			(message) => message.role === 'user',
		)
		if (lastUserIdx !== -1) {
			await this.skillRepository?.refresh()
			const prevMessages = agent.timeline.slice(0, lastUserIdx)
			const current = captureWorkspaceContexts(
				this.plugin.app,
				this.skillRepository,
			)
			const changed = computeChangedContexts(prevMessages, current)
			const message = agent.timeline[lastUserIdx]
			message.parts = message.parts.filter(
				(part) => part.type !== 'data-workspace-context',
			)
			if (changed.length) {
				message.parts.unshift({
					type: 'data-workspace-context',
					data: { deltas: changed },
				})
			}
		}

		runtime.runState = 'thinking'
		await this.store.persistSession(session)
		this.notify()
		await this.requestRun(session.id)
		if (messagesAfter.length > 0) {
			const updatedAgent = this.messageFactory.getActiveAgent(session)
			updatedAgent.timeline = [...updatedAgent.timeline, ...messagesAfter]
			await this.store.persistSession(session)
			this.notify()
		}
	}

	async restoreFilesForRecall(operations: ReversibleToolOp[]) {
		const normalizedOperations = operations
			.map(normalizeReversibleToolOpRecord)
			.filter((op): op is ReversibleToolOp => !!op)
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
			Extract<ReversibleToolOp, { operation: 'update' }>['before']
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
		content: Extract<ReversibleToolOp, { operation: 'update' }>['before'],
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
