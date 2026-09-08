import type { ChatSession } from '~/ai/chat/domain'
import type { ReversibleToolOp } from '~/ai/chat/types'
import type { App } from 'obsidian'
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
import {
	isSessionExecutionPending,
	type RuntimeStates,
} from '~/ai/chat/runtime/runtime-state'
import type { SessionStore } from '~/ai/chat/session/session-store'
import type { RecallMessageResult } from '~/ai/chat/ui/types'
import logger from '~/utils/logger'
import type { SkillRepository } from '~/ai/skills/repository'
import {
	createVaultFileSystem,
	type VaultFileSystemManager,
} from '~/ai/tools/vault-filesystem'
import type {
	SettingsSnapshotFn,
	SettingsUpdater,
} from '~/ai/tools/tool-context'
import { posix as pathPosix } from 'path-browserify'
import { normalizeLegacyVirtualPath } from '~/ai/tools/bash/mount-points'
import type { RegenerationTransaction } from '~/ai/chat/runtime/regeneration'

export async function restoreVirtualReversibleOperations(
	app: App,
	operations: ReversibleToolOp[],
	options: {
		fileSystemManager?: VaultFileSystemManager
		settingsIo?: {
			getSettingsSnapshot: SettingsSnapshotFn
			updateSettings: SettingsUpdater
		}
	} = {},
) {
	const fs = await createVaultFileSystem(app, {
		fileSystemManager: options.fileSystemManager,
		getSettingsSnapshot: options.settingsIo?.getSettingsSnapshot,
		updateSettings: options.settingsIo?.updateSettings,
	})
	const earliest = new Map<string, ReversibleToolOp>()
	for (const operation of operations) {
		const normalizedPath = normalizeLegacyVirtualPath(operation.vaultPath)
		if (!earliest.has(normalizedPath)) {
			earliest.set(normalizedPath, operation)
		}
	}
	for (const [path, operation] of [...earliest.entries()].reverse()) {
		if (operation.operation === 'create') {
			if (await fs.exists(path)) await fs.rm(path, { recursive: true })
			continue
		}
		if (operation.before.kind === 'dir') {
			await fs.mkdir(path, { recursive: true })
			continue
		}
		await fs.mkdir(pathPosix.dirname(path), { recursive: true })
		await fs.writeFile(
			path,
			new Uint8Array(await decodeReversibleFileSnapshot(operation.before)),
		)
	}
}

export class MessageOps {
	constructor(
		private app: App,
		private state: ChatState,
		private runtimeStates: RuntimeStates,
		private store: SessionStore,
		private notify: () => void,
		private reportTransientError: (message: string) => void,
		private messageFactory: MessageFactory,
		private validateSelection: (session: ChatSession) => boolean,
		private enqueueRegenerate: (
			sessionId: string,
			targetMessageId: string,
		) => boolean,
		private skillRepository?: SkillRepository,
		private settingsIo?: {
			getSettingsSnapshot: SettingsSnapshotFn
			updateSettings: SettingsUpdater
		},
		private fileSystemManager?: VaultFileSystemManager,
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
			this.reportTransientError(
				error instanceof Error ? error.message : String(error),
			)
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
		if (isSessionExecutionPending(runtime)) {
			return
		}
		const agent = this.messageFactory.getActiveAgent(session)
		const idx = agent.timeline.findIndex((message) => message.id === messageId)
		if (idx === -1) {
			return
		}
		this.enqueueRegenerate(session.id, messageId)
	}

	async beginRegeneration(
		session: ChatSession,
		targetMessageId: string,
		isCurrent: () => boolean,
	): Promise<RegenerationTransaction | undefined> {
		const agent = this.messageFactory.getActiveAgent(session)
		const idx = agent.timeline.findIndex(
			(message) => message.id === targetMessageId,
		)
		if (idx === -1) return undefined
		await this.skillRepository?.refresh()
		if (!isCurrent()) return undefined

		const originalTimeline = agent.timeline.slice()
		const originalOperations = Object.fromEntries(
			Object.entries(agent.operations).map(([id, operations]) => [
				id,
				operations.slice(),
			]),
		)
		const originalToolTimings = Object.fromEntries(
			Object.entries(agent.toolTimings).map(([id, timing]) => [
				id,
				{ ...timing },
			]),
		)
		const originalSessionIndexPosition = this.state.sessionIndex.findIndex(
			(item) => item.id === session.id,
		)
		const originalSessionUpdatedAt = session.updatedAt
		const prefix = originalTimeline.slice(0, idx)
		const suffix = originalTimeline.slice(idx + 1)

		let lastUserIdx = -1
		for (let index = prefix.length - 1; index >= 0; index -= 1) {
			if (prefix[index].role === 'user') {
				lastUserIdx = index
				break
			}
		}
		if (lastUserIdx !== -1) {
			const prevMessages = prefix.slice(0, lastUserIdx)
			const current = captureWorkspaceContexts(this.app, this.skillRepository)
			const changed = computeChangedContexts(prevMessages, current)
			const message = prefix[lastUserIdx]
			prefix[lastUserIdx] = {
				...message,
				parts: message.parts.filter(
					(part) => part.type !== 'data-workspace-context',
				),
			}
			if (changed.length) {
				prefix[lastUserIdx].parts.unshift({
					type: 'data-workspace-context',
					data: { deltas: changed },
				})
			}
		}

		agent.timeline = prefix
		return {
			targetMessageId,
			targetToolCallIds: originalTimeline[idx].parts.flatMap((part) =>
				part.type === 'dynamic-tool' ? [part.toolCallId] : [],
			),
			originalTimeline,
			originalOperations,
			originalToolTimings,
			originalReadVaultPaths: agent.readVaultPaths?.slice(),
			originalSessionUpdatedAt,
			originalSessionIndexItem:
				originalSessionIndexPosition === -1
					? undefined
					: {
							...this.state.sessionIndex[originalSessionIndexPosition],
						},
			originalSessionIndexPosition,
			prefixLength: prefix.length,
			suffix,
		}
	}

	commitRegeneration(
		session: ChatSession,
		transaction: RegenerationTransaction,
	) {
		const agent = this.messageFactory.getActiveAgent(session)
		delete agent.operations[transaction.targetMessageId]
		for (const toolCallId of transaction.targetToolCallIds) {
			delete agent.toolTimings[toolCallId]
		}
		agent.timeline = [...agent.timeline, ...transaction.suffix]
	}

	rollbackRegeneration(
		session: ChatSession,
		transaction: RegenerationTransaction,
	) {
		const agent = this.messageFactory.getActiveAgent(session)
		agent.timeline = transaction.originalTimeline.slice()
		agent.operations = Object.fromEntries(
			Object.entries(transaction.originalOperations).map(([id, operations]) => [
				id,
				operations.slice(),
			]),
		)
		agent.toolTimings = Object.fromEntries(
			Object.entries(transaction.originalToolTimings).map(([id, timing]) => [
				id,
				{ ...timing },
			]),
		)
		agent.readVaultPaths = transaction.originalReadVaultPaths?.slice()
		session.updatedAt = transaction.originalSessionUpdatedAt
		const currentIndexPosition = this.state.sessionIndex.findIndex(
			(item) => item.id === session.id,
		)
		if (transaction.originalSessionIndexItem) {
			const restored = { ...transaction.originalSessionIndexItem }
			if (currentIndexPosition === -1) {
				const position = Math.min(
					transaction.originalSessionIndexPosition,
					this.state.sessionIndex.length,
				)
				this.state.sessionIndex = [
					...this.state.sessionIndex.slice(0, position),
					restored,
					...this.state.sessionIndex.slice(position),
				]
			} else {
				this.state.sessionIndex = this.state.sessionIndex.slice()
				this.state.sessionIndex[currentIndexPosition] = restored
			}
		} else if (currentIndexPosition !== -1) {
			this.state.sessionIndex = this.state.sessionIndex.filter(
				(item) => item.id !== session.id,
			)
		}
	}

	async restoreFilesForRecall(operations: ReversibleToolOp[]) {
		const normalizedOperations = operations
			.map(normalizeReversibleToolOpRecord)
			.filter((op): op is ReversibleToolOp => !!op)
		if (normalizedOperations.length === 0) {
			return
		}
		const virtualOperations = normalizedOperations.filter((operation) =>
			operation.vaultPath.startsWith('/'),
		)
		if (virtualOperations.length > 0) {
			await this.restoreVirtualFilesForRecall(virtualOperations)
		}
		const legacyOperations = normalizedOperations.filter(
			(operation) => !operation.vaultPath.startsWith('/'),
		)
		if (legacyOperations.length === 0) return

		const earliestByPath = new Map<string, (typeof legacyOperations)[number]>()
		for (const operation of legacyOperations) {
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

	private async restoreVirtualFilesForRecall(operations: ReversibleToolOp[]) {
		await restoreVirtualReversibleOperations(this.app, operations, {
			fileSystemManager: this.fileSystemManager,
			settingsIo: this.settingsIo,
		})
	}

	private async deleteVaultPathIfExists(path: string) {
		const target = this.app.vault.getAbstractFileByPath(path)
		if (!target) {
			return
		}
		if (isVaultFolder(target) && target.children.length > 0) {
			logger.info(`Recall restore skip non-empty dir: ${path}`)
			return
		}
		logger.info(`Recall restore delete: ${path}`)
		await this.app.fileManager.trashFile(target)
	}

	private async ensureVaultDirectory(path: string) {
		if (!path) {
			return
		}
		const target = this.app.vault.getAbstractFileByPath(path)
		if (target) {
			if (isVaultFolder(target)) {
				return
			}
			throw new Error(`Unable to restore ${path}: a file already exists there.`)
		}
		logger.info(`Recall restore mkdir: ${path}`)
		await this.app.vault.createFolder(path)
	}

	private async writeVaultFile(
		path: string,
		content: Extract<ReversibleToolOp, { operation: 'update' }>['before'],
	) {
		const data = await decodeReversibleFileSnapshot(content)
		const existing = this.app.vault.getAbstractFileByPath(path)
		if (existing && isVaultFolder(existing)) {
			throw new Error(
				`Unable to restore ${path}: a directory already exists there.`,
			)
		}
		if (existing && isVaultFile(existing)) {
			logger.info(`Recall restore write: ${path} (overwrite)`)
			await this.app.vault.modifyBinary(existing as never, data)
			return
		}
		logger.info(`Recall restore write: ${path} (create)`)
		await this.app.vault.createBinary(path, data)
	}

	private getLoadedActiveSession() {
		return this.state.activeSessionId
			? this.state.loadedSessions.get(this.state.activeSessionId)
			: undefined
	}
}
