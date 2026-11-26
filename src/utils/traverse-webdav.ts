import { dirname, normalize } from 'path-browserify'
import { DeltaEntry, getDelta } from '~/api/delta'
import { getLatestDeltaCursor } from '~/api/latestDeltaCursor'
import {
	getDirectoryContents,
	statRemotePath,
	type UnreadablePropfindItem,
} from '~/api/webdav'
import { StatModel } from '~/model/stat.model'
import type { NutstoreSettings } from '~/settings'
import { traverseWebDAVKV, type RemoteUnreadableEntry } from '~/storage'
import { AsyncMutex } from './async-lock'
import { fileStatToStatModel } from './file-stat-to-stat-model'
import { TRAVERSAL_CACHE_SCHEMA } from './get-db-key'
import { getRootFolderName } from './get-root-folder-name'
import logger from './logger'
import { RequestUrlError } from './request-url-error'
import { retryWith503Backoff } from './retry-503'
import { stdRemotePath } from './std-remote-path'
import { isTraversalCacheCompatible } from './traversal-cache-compat'
import { MaybePromise } from './types'

export const FULL_RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1000

// Global mutex map: one lock per kvKey
const traversalLocks = new Map<string, AsyncMutex>()

function getTraversalLock(kvKey: string): AsyncMutex {
	if (!traversalLocks.has(kvKey)) {
		traversalLocks.set(kvKey, new AsyncMutex())
	}
	return traversalLocks.get(kvKey)!
}

function pathDepth(normalizedPath: string): number {
	return normalizedPath.split('/').filter(Boolean).length
}

export interface WebDAVTraversalProgress {
	phase: 'scanning' | 'incremental' | 'retrying' | 'complete'
	currentPath?: string
	processedDirectories: number
	queuedDirectories: number
	discoveredItems: number
	processedChanges: number
}

interface MergedDeltaItem {
	key: string
	entry: DeltaEntry
	invalidatedSubtree: boolean
	isSelf: boolean
}

type ResolvedFileWrite =
	| { kind: 'keep-existing'; stat: Extract<StatModel, { isDir: false }> }
	| { kind: 'file'; stat: Extract<StatModel, { isDir: false }> }
	| { kind: 'dir-flip'; stat: Extract<StatModel, { isDir: true }> }
	| { kind: 'missing-verify'; path: string }
	| { kind: 'unreadable'; path: string; status?: string }

export class ResumableWebDAVTraversal {
	private token: string
	private remoteBaseDir: string
	private kvKey: string
	private saveInterval: number
	private saveIntervalMs: number
	private fullRescanIntervalMs: number
	private now: () => number
	private settings: NutstoreSettings
	private onProgress?: (progress: WebDAVTraversalProgress) => void
	private throwIfCancelled?: () => void

	private rootCursor: string = ''
	private queue: string[] = []
	// A 404 is incomplete observation, never proof of deletion. Persist until reconciled.
	private pendingVerification = new Set<string>()
	// PROPFIND entries lacking a 200 propstat (e.g., per-item 403). Persisted so
	// subsequent incremental runs keep protecting their subtrees via SyncScope.
	private unreadablePaths = new Map<string, RemoteUnreadableEntry>()
	private nodes: Record<string, StatModel[]> = {}
	private lastFullScanAt?: number
	private fullScanFromRoot = false
	private processedCount: number = 0
	private discoveredCount: number = 0
	private processedChanges: number = 0
	private dirty = false
	private lastSavedAt = 0

	/**
	 * Normalize directory path for use as nodes key
	 */
	private normalizeDirPath(path: string): string {
		return stdRemotePath(path)
	}

	/**
	 * Normalize file/directory path for comparison
	 * Uses normalize to handle //, ./, etc, then removes trailing slash for consistent comparison
	 */
	private normalizeForComparison(path: string): string {
		let normalized = normalize(path)
		if (normalized.endsWith('/') && normalized.length > 1) {
			normalized = normalized.slice(0, -1)
		}
		return normalized
	}

	constructor(options: {
		settings: NutstoreSettings
		token: string
		remoteBaseDir: string
		kvKey: string
		saveInterval?: number
		saveIntervalMs?: number
		fullRescanIntervalMs?: number
		now?: () => number
		onProgress?: (progress: WebDAVTraversalProgress) => void
		throwIfCancelled?: () => void
	}) {
		this.settings = options.settings
		this.token = options.token
		this.remoteBaseDir = options.remoteBaseDir
		this.kvKey = options.kvKey
		this.saveInterval = Math.max(options.saveInterval ?? 50, 1)
		this.saveIntervalMs = Math.max(options.saveIntervalMs ?? 5_000, 1)
		this.fullRescanIntervalMs = Math.max(
			options.fullRescanIntervalMs ?? FULL_RESCAN_INTERVAL_MS,
			1,
		)
		this.now = options.now ?? (() => Date.now())
		this.onProgress = options.onProgress
		this.throwIfCancelled = options.throwIfCancelled
	}

	private emitProgress(
		phase: WebDAVTraversalProgress['phase'],
		currentPath?: string,
	): void {
		this.onProgress?.({
			phase,
			currentPath,
			processedDirectories: this.processedCount,
			queuedDirectories: this.queue.length,
			discoveredItems: this.discoveredCount,
			processedChanges: this.processedChanges,
		})
	}

	private checkCancelled(): void {
		this.throwIfCancelled?.()
	}

	private executeWithRetry<T>(
		func: () => MaybePromise<T>,
		currentPath?: string,
	): Promise<T> {
		return retryWith503Backoff(func, {
			throwIfCancelled: this.throwIfCancelled,
			onRetry: () => this.emitProgress('retrying', currentPath),
		})
	}

	get lock() {
		return getTraversalLock(this.kvKey)
	}

	private markDirty(): void {
		this.dirty = true
	}

	private shouldFlushThrottled(unsavedCount: number): boolean {
		return (
			this.dirty &&
			(unsavedCount >= this.saveInterval ||
				this.now() - this.lastSavedAt >= this.saveIntervalMs)
		)
	}

	private async syncLocked(): Promise<void> {
		this.checkCancelled()
		this.lastSavedAt = this.now()
		await this.loadState()

		const hasCompleteCache =
			this.queue.length === 0 &&
			this.pendingVerification.size === 0 &&
			Boolean(this.rootCursor) &&
			Object.keys(this.nodes).length > 0

		// ACL/sharing changes never emit delta events, so periodic full scans re-verify the tree.
		const needsPeriodicRescan =
			hasCompleteCache &&
			(this.lastFullScanAt === undefined ||
				this.now() - this.lastFullScanAt >= this.fullRescanIntervalMs)

		try {
			if (hasCompleteCache && !needsPeriodicRescan) {
				await this.incrementalScan()
			} else {
				if (
					needsPeriodicRescan ||
					(this.queue.length === 0 && this.pendingVerification.size === 0)
				) {
					// Fetch the fresh cursor before clearing local state so an error or
					// cancellation never persists an empty mirror over a valid cache.
					const { response } = await this.executeWithRetry(() =>
						getLatestDeltaCursor({
							token: this.token,
							throwIfCancelled: this.throwIfCancelled,
							settings: this.settings,
							folderName: getRootFolderName(this.remoteBaseDir),
						}),
					)
					if (needsPeriodicRescan) {
						this.nodes = {}
						this.pendingVerification.clear()
						this.unreadablePaths.clear()
						this.processedCount = 0
						this.discoveredCount = 0
					}
					this.rootCursor = response.cursor
					this.queue = [this.remoteBaseDir]
					this.lastFullScanAt = undefined
					this.fullScanFromRoot = true
					this.markDirty()
				} else if (this.lastFullScanAt === undefined) {
					// Resuming an incomplete initial, reset, or periodic full scan.
					this.fullScanFromRoot = true
				}

				await this.bfsTraverse()
			}
		} finally {
			await this.saveState({ allowWhenCancelled: true })
		}
		this.emitProgress('complete')
	}

	async traverse(): Promise<StatModel[]> {
		return await this.lock.runExclusive(async () => {
			await this.syncLocked()
			return this.getAllFromCache()
		})
	}

	getUnreadableEntries(): RemoteUnreadableEntry[] {
		return [...this.unreadablePaths.values()]
	}

	private recordUnreadable(
		path: string,
		operation: 'list' | 'stat',
		status?: string,
	): void {
		const key = this.normalizeForComparison(path)
		if (!this.isWithinRemoteScope(key)) return
		const next: RemoteUnreadableEntry = {
			path: key,
			operation,
			...(status ? { status } : {}),
		}
		const prev = this.unreadablePaths.get(key)
		if (
			!prev ||
			prev.operation !== next.operation ||
			prev.status !== next.status
		) {
			this.unreadablePaths.set(key, next)
			this.markDirty()
		}
	}

	private clearUnreadable(path: string): void {
		const key = this.normalizeForComparison(path)
		if (this.unreadablePaths.delete(key)) {
			this.markDirty()
		}
	}

	private clearDirectUnreadableChildren(parentDir: string): void {
		const parentKey = this.normalizeDirPath(parentDir)
		for (const key of [...this.unreadablePaths.keys()]) {
			if (this.normalizeDirPath(dirname(key)) === parentKey) {
				this.unreadablePaths.delete(key)
				this.markDirty()
			}
		}
	}

	private clearUnreadableSubtree(path: string): void {
		const targetCmp = this.normalizeForComparison(path)
		const prefix = this.normalizeDirPath(path)
		for (const key of [...this.unreadablePaths.keys()]) {
			if (key === targetCmp || this.normalizeDirPath(key).startsWith(prefix)) {
				this.unreadablePaths.delete(key)
				this.markDirty()
			}
		}
	}

	/**
	 * BFS traversal (initial scan or resume)
	 */
	private async bfsTraverse(): Promise<StatModel[]> {
		// Remember paths across repairs and subtree invalidation within this invocation.
		// Normal scans may need any number of passes; the same unresolved directory
		// must not cycle through verification -> BFS -> verification indefinitely.
		const suspendedDirectories = new Set(this.pendingVerification)
		let unsavedDirs = 0
		while (true) {
			const traverseStartCursor = this.rootCursor

			while (this.queue.length > 0) {
				this.checkCancelled()
				const currentPath = this.queue[0]
				this.emitProgress('scanning', currentPath)
				const normalizedPath = this.normalizeDirPath(currentPath)
				const resultItems: StatModel[] = []

				try {
					const cachedItems = this.nodes[normalizedPath]

					if (cachedItems) {
						resultItems.push(...cachedItems)
					} else {
						const unreadableItems: UnreadablePropfindItem[] = []
						const contents = await getDirectoryContents(
							this.settings,
							this.token,
							currentPath,
							this.throwIfCancelled,
							() => this.emitProgress('retrying', currentPath),
							(item) => unreadableItems.push(item),
						)

						const currentCmp = this.normalizeForComparison(currentPath)
						const selfUnreadable = unreadableItems.find(
							(item) => this.normalizeForComparison(item.path) === currentCmp,
						)
						if (selfUnreadable) {
							if (
								normalizedPath === this.normalizeDirPath(this.remoteBaseDir)
							) {
								throw new Error(
									`Remote sync root is unreadable (${selfUnreadable.status ?? 'unknown status'}): ${currentCmp}`,
								)
							}
							this.recordUnreadable(currentCmp, 'list', selfUnreadable.status)
						} else {
							this.clearUnreadable(currentCmp)
						}

						this.clearDirectUnreadableChildren(normalizedPath)
						for (const item of unreadableItems) {
							const itemCmp = this.normalizeForComparison(item.path)
							if (itemCmp !== currentCmp) {
								this.recordUnreadable(itemCmp, 'stat', item.status)
							}
						}

						for (const item of contents) {
							const stat = fileStatToStatModel(item)
							this.clearUnreadable(stat.path)
							resultItems.push(stat)
						}
						this.discoveredCount += resultItems.length
					}

					for (const item of resultItems) {
						if (item.isDir) {
							this.enqueueDirectory(item.path)
						}
					}

					this.nodes[normalizedPath] = resultItems

					this.queue.shift()
					this.pendingVerification.delete(normalizedPath)
					this.markDirty()
					this.processedCount++
					unsavedDirs++
					this.emitProgress('scanning', currentPath)

					if (this.shouldFlushThrottled(unsavedDirs)) {
						await this.saveState()
						unsavedDirs = 0
					}
				} catch (err) {
					if (
						err instanceof RequestUrlError &&
						err.res.status === 404 &&
						normalizedPath !== this.normalizeDirPath(this.remoteBaseDir)
					) {
						this.queue.shift()
						this.suspendDirectory(normalizedPath, suspendedDirectories)
						await this.saveState()
						unsavedDirs = 0
						continue
					}
					logger.error(`Error processing ${currentPath}`, err)
					throw err
				}
			}

			// Directly replay delta from the pre-scan cursor without re-querying latestDeltaCursor,
			// ensuring no modifications made during BFS can be missed.
			if (traverseStartCursor) {
				this.rootCursor =
					await this.applyDeltaDuringTraversal(traverseStartCursor)
			}

			const refreshed =
				await this.reconcilePendingDirectories(suspendedDirectories)
			if (
				!refreshed &&
				this.queue.length === 0 &&
				this.pendingVerification.size === 0
			) {
				if (this.fullScanFromRoot) {
					this.lastFullScanAt = this.now()
					this.fullScanFromRoot = false
					this.markDirty()
				}
				return this.getAllFromCache()
			}
		}
	}

	/** A path may be suspended only once per traversal, even across cache resets. */
	private suspendDirectory(
		path: string,
		suspendedDirectories: Set<string>,
	): void {
		const key = this.normalizeDirPath(path)
		this.pendingVerification.add(key)
		this.markDirty()
		if (suspendedDirectories.has(key)) {
			throw new Error(
				`Remote directory returned 404 again after suspension: ${key}`,
			)
		}
		suspendedDirectories.add(key)
	}

	private enqueueDirectory(path: string): void {
		const key = this.normalizeDirPath(path)
		if (
			!this.nodes[key] &&
			!this.queue.some((item) => this.normalizeDirPath(item) === key)
		) {
			this.queue.push(path)
			this.markDirty()
		}
	}

	/** Invalidate an absent or untrusted subtree, including its unfinished work. */
	private removeSubtree(path: string): void {
		const prefix = this.normalizeDirPath(path)
		let changed = false
		for (const key of Object.keys(this.nodes)) {
			if (this.normalizeDirPath(key).startsWith(prefix)) {
				delete this.nodes[key]
				changed = true
			}
		}
		const nextQueue = this.queue.filter(
			(item) => !this.normalizeDirPath(item).startsWith(prefix),
		)
		if (nextQueue.length !== this.queue.length) {
			this.queue = nextQueue
			changed = true
		}
		for (const item of this.pendingVerification) {
			if (this.normalizeDirPath(item).startsWith(prefix)) {
				this.pendingVerification.delete(item)
				changed = true
			}
		}
		this.clearUnreadableSubtree(path)
		if (changed) this.markDirty()
	}

	/** Each ascent strictly reduces path depth and must remain inside the sync root. */
	private getRecoveryParent(path: string): string {
		const current = this.normalizeDirPath(path)
		const root = this.normalizeDirPath(this.remoteBaseDir)
		const parent = this.normalizeDirPath(
			dirname(this.normalizeForComparison(current)),
		)
		if (
			!current.startsWith(root) ||
			current === root ||
			parent.length >= current.length ||
			!parent.startsWith(root)
		) {
			throw new Error(
				'Cannot reconcile a missing directory outside the sync root',
			)
		}
		return parent
	}

	/** Fresh parent listings resolve stale paths without discarding unrelated branches. */
	private async reconcilePendingDirectories(
		suspendedDirectories: Set<string>,
	): Promise<boolean> {
		const refreshed = new Set<string>()
		for (const missing of [...this.pendingVerification]) {
			if (!this.pendingVerification.has(missing)) continue
			let parent = this.getRecoveryParent(missing)
			while (!refreshed.has(parent)) {
				this.checkCancelled()
				let contents: StatModel[]
				const unreadableItems: UnreadablePropfindItem[] = []
				try {
					contents = (
						await getDirectoryContents(
							this.settings,
							this.token,
							parent,
							this.throwIfCancelled,
							() => this.emitProgress('retrying', parent),
							(item) => unreadableItems.push(item),
						)
					).map(fileStatToStatModel)
				} catch (error) {
					if (
						!(error instanceof RequestUrlError) ||
						error.res.status !== 404 ||
						parent === this.normalizeDirPath(this.remoteBaseDir)
					)
						throw error
					this.suspendDirectory(parent, suspendedDirectories)
					parent = this.getRecoveryParent(parent)
					continue
				}
				const parentCmp = this.normalizeForComparison(parent)
				const parentSelfUnreadable = unreadableItems.find(
					(item) => this.normalizeForComparison(item.path) === parentCmp,
				)
				if (
					parentSelfUnreadable &&
					parent === this.normalizeDirPath(this.remoteBaseDir)
				) {
					throw new Error(
						`Remote sync root is unreadable (${parentSelfUnreadable.status ?? 'unknown status'}): ${parentCmp}`,
					)
				}
				refreshed.add(parent)
				const directories = new Set(
					contents
						.filter((item) => item.isDir)
						.map((item) => this.normalizeDirPath(item.path)),
				)
				const previous = [
					...(this.nodes[parent] ?? [])
						.filter((item) => item.isDir)
						.map((item) => item.path),
					...this.pendingVerification,
				]
				for (const path of previous) {
					if (
						this.normalizeDirPath(
							dirname(this.normalizeForComparison(path)),
						) === parent &&
						!directories.has(this.normalizeDirPath(path))
					) {
						this.removeSubtree(path)
					}
				}
				this.nodes[parent] = contents
				this.pendingVerification.delete(parent)
				this.markDirty()
				for (const path of directories) {
					if (this.pendingVerification.has(path)) {
						// An absent/recreated ancestor invalidates its entire old subtree.
						this.removeSubtree(path)
						this.pendingVerification.add(path)
						this.markDirty()
					}
					this.enqueueDirectory(path)
				}
				// Apply fresh unreadable entries after subtree cleanup so per-item
				// errors (e.g., 403 on a previously cached subdir) are preserved.
				if (parentSelfUnreadable) {
					this.recordUnreadable(parentCmp, 'list', parentSelfUnreadable.status)
				} else {
					this.clearUnreadable(parentCmp)
				}
				this.clearDirectUnreadableChildren(parent)
				for (const item of unreadableItems) {
					const itemCmp = this.normalizeForComparison(item.path)
					if (itemCmp !== parentCmp) {
						this.recordUnreadable(itemCmp, 'stat', item.status)
					}
				}
				for (const item of contents) {
					this.clearUnreadable(item.path)
				}
				await this.saveState()
				break
			}
		}
		return refreshed.size > 0
	}

	/**
	 * Fetch all delta changes by paginating through hasMore
	 * Yields batches of delta entries as they are fetched
	 */
	private async *fetchAllDelta(startCursor: string): AsyncGenerator<{
		entries: DeltaEntry[]
		cursor: string
		reset: boolean
		hasMore: boolean
	}> {
		let currentCursor = startCursor
		const seenCursors = new Set<string>(currentCursor ? [currentCursor] : [])

		while (true) {
			const { response } = await this.executeWithRetry(() =>
				getDelta({
					token: this.token,
					throwIfCancelled: this.throwIfCancelled,
					settings: this.settings,
					folderName: getRootFolderName(this.remoteBaseDir),
					cursor: currentCursor,
				}),
			)

			if (response.reset) {
				yield {
					entries: [],
					cursor: response.cursor,
					reset: true,
					hasMore: false,
				}
				return
			}

			if (!response.cursor) {
				logger.error('Delta response missing cursor while reset=false')
				throw new Error('Delta response missing cursor while reset is false')
			}

			if (response.hasMore && seenCursors.has(response.cursor)) {
				logger.error(
					`Delta cursor stalled at "${response.cursor}" while hasMore=true`,
				)
				throw new Error('Delta cursor stalled while hasMore is true')
			}

			seenCursors.add(response.cursor)
			currentCursor = response.cursor

			yield {
				entries: response.delta.entry,
				cursor: currentCursor,
				reset: false,
				hasMore: response.hasMore,
			}

			if (!response.hasMore) {
				break
			}
		}
	}

	/**
	 * Apply changes during traversal without re-scanning
	 * Returns the new cursor. If reset occurred, clears cache and sets queue for re-scan.
	 */
	private async applyDeltaDuringTraversal(
		startCursor: string,
	): Promise<string> {
		let finalCursor = startCursor
		let processedEntries = 0

		for await (const { entries, cursor, reset } of this.fetchAllDelta(
			startCursor,
		)) {
			this.checkCancelled()
			if (reset) {
				logger.warn(
					'Delta reset during traversal, clearing cache and will trigger full re-scan',
				)
				// Fetch the fresh cursor before clearing local state so an interruption
				// never persists an empty mirror paired with an expired cursor.
				const { response: cursorResponse } = await this.executeWithRetry(() =>
					getLatestDeltaCursor({
						token: this.token,
						throwIfCancelled: this.throwIfCancelled,
						settings: this.settings,
						folderName: getRootFolderName(this.remoteBaseDir),
					}),
				)
				this.nodes = {}
				this.pendingVerification.clear()
				this.unreadablePaths.clear()
				this.queue = [this.remoteBaseDir]
				this.lastFullScanAt = undefined
				this.fullScanFromRoot = true
				this.processedCount = 0
				this.rootCursor = cursorResponse.cursor
				this.markDirty()
				return this.rootCursor
			}

			if (entries.length > 0) {
				processedEntries += await this.applyDeltaPage(entries, cursor)

				// Save state periodically based on number of processed entries
				if (this.shouldFlushThrottled(processedEntries)) {
					await this.saveState()
					processedEntries = 0
				}
			} else if (cursor !== this.rootCursor) {
				this.rootCursor = cursor
				this.markDirty()
			}

			finalCursor = cursor
		}

		return finalCursor
	}

	/**
	 * Incremental scan using fetchAllDelta
	 */
	private async incrementalScan(): Promise<StatModel[]> {
		this.rootCursor = await this.applyDeltaDuringTraversal(this.rootCursor)
		if (this.queue.length > 0 || this.pendingVerification.size > 0) {
			return this.bfsTraverse()
		}
		return this.getAllFromCache()
	}

	private getCachedNodeKind(normalizedPath: string): 'dir' | 'file' | 'none' {
		const dirKey = this.normalizeDirPath(normalizedPath)
		if (this.nodes[dirKey]) {
			return 'dir'
		}
		const parentPath = dirname(normalizedPath)
		if (!parentPath || parentPath === normalizedPath) {
			return 'none'
		}
		const parentItems = this.nodes[this.normalizeDirPath(parentPath)]
		if (!parentItems) {
			return 'none'
		}
		const existing = parentItems.find(
			(item) => this.normalizeForComparison(item.path) === normalizedPath,
		)
		if (!existing) return 'none'
		return existing.isDir ? 'dir' : 'file'
	}

	private isWithinRemoteScope(normalizedPath: string): boolean {
		const base = this.normalizeForComparison(this.remoteBaseDir)
		if (normalizedPath === base) return true
		const prefix = base === '/' ? '/' : `${base}/`
		return normalizedPath.startsWith(prefix)
	}

	private upsertChildInParent(parentKey: string, stat: StatModel): void {
		const parentItems = this.nodes[parentKey]
		if (!parentItems) return
		const targetCmp = this.normalizeForComparison(stat.path)
		this.nodes[parentKey] = [
			...parentItems.filter(
				(item) => this.normalizeForComparison(item.path) !== targetCmp,
			),
			stat,
		]
	}

	private removeChildFromParent(parentKey: string, targetCmp: string): void {
		const parentItems = this.nodes[parentKey]
		if (!parentItems) return
		this.nodes[parentKey] = parentItems.filter(
			(item) => this.normalizeForComparison(item.path) !== targetCmp,
		)
	}

	/**
	 * Atomically validates and commits one delta page:
	 * 1) Merges events per path while preserving whether any old subtree was invalidated;
	 * 2) Pre-resolves file writes via `PROPFIND Depth: 0` before any cache/cursor mutation;
	 * 3) Commits invalidated subtrees + reverse-depth deletes + forward-depth writes + next cursor.
	 */
	private async applyDeltaPage(
		entries: Array<DeltaEntry>,
		nextCursor: string,
	): Promise<number> {
		const baseComparison = this.normalizeForComparison(this.remoteBaseDir)
		const merged = new Map<string, MergedDeltaItem>()
		const sawDirectoryEvent = new Set<string>()

		for (const entry of entries) {
			const key = this.normalizeForComparison(entry.path)
			if (!this.isWithinRemoteScope(key)) {
				continue
			}
			if (entry.isDir) {
				sawDirectoryEvent.add(key)
			}
			const prev = merged.get(key)
			const existingKind = this.getCachedNodeKind(key)
			const typeFlippedFromBatch =
				prev !== undefined && prev.entry.isDir !== entry.isDir
			const typeFlippedFromCache =
				(existingKind === 'dir' && !entry.isDir) ||
				(existingKind === 'file' && entry.isDir)
			const invalidatedSubtree =
				(prev?.invalidatedSubtree ?? false) ||
				entry.isDeleted ||
				typeFlippedFromBatch ||
				typeFlippedFromCache
			merged.set(key, {
				key,
				entry,
				invalidatedSubtree,
				isSelf: key === baseComparison,
			})
		}

		const items = [...merged.values()]
		const deletes = items
			.filter((item) => item.entry.isDeleted)
			.sort((a, b) => pathDepth(b.key) - pathDepth(a.key))
		const writes = items
			.filter((item) => !item.entry.isDeleted)
			.sort((a, b) => pathDepth(a.key) - pathDepth(b.key))

		const invalidatedDirPrefixes: string[] = []
		for (const item of items) {
			const mightHaveOldDir =
				item.entry.isDir ||
				sawDirectoryEvent.has(item.key) ||
				this.getCachedNodeKind(item.key) === 'dir'
			if (item.invalidatedSubtree && mightHaveOldDir) {
				invalidatedDirPrefixes.push(this.normalizeDirPath(item.key))
			}
		}

		const isCoveredByInvalidation = (dirKey: string) =>
			invalidatedDirPrefixes.some((prefix) => dirKey.startsWith(prefix))

		// Phase A: resolve file metadata via PROPFIND Depth: 0 without mutating cache or cursor.
		const resolvedFiles = new Map<string, ResolvedFileWrite>()
		for (const item of writes) {
			if (item.entry.isDir || item.isSelf) continue
			const parentKey = this.normalizeDirPath(dirname(item.key))
			if (!this.nodes[parentKey] || isCoveredByInvalidation(parentKey)) {
				continue
			}

			const existing = this.nodes[parentKey].find(
				(node) => this.normalizeForComparison(node.path) === item.key,
			)
			if (
				!item.invalidatedSubtree &&
				existing &&
				!existing.isDir &&
				item.entry.revision !== undefined &&
				existing.revision !== undefined &&
				existing.revision === item.entry.revision &&
				existing.etag
			) {
				resolvedFiles.set(item.key, {
					kind: 'keep-existing',
					stat: existing,
				})
				continue
			}

			const result = await statRemotePath(
				this.settings,
				this.token,
				item.key,
				this.throwIfCancelled,
				() => this.emitProgress('retrying', item.key),
			)
			if (result.status === 'not-found') {
				resolvedFiles.set(item.key, {
					kind: 'missing-verify',
					path: item.key,
				})
			} else if (result.status === 'unreadable') {
				resolvedFiles.set(item.key, {
					kind: 'unreadable',
					path: item.key,
					status: result.statusText,
				})
			} else if (result.stat.isDir) {
				resolvedFiles.set(item.key, {
					kind: 'dir-flip',
					stat: result.stat,
				})
			} else {
				resolvedFiles.set(item.key, {
					kind: 'file',
					stat: {
						...result.stat,
						...(item.entry.revision !== undefined
							? { revision: item.entry.revision }
							: {}),
					},
				})
			}
		}

		// Phase B: commit everything synchronously once all network calls succeeded.
		for (const prefix of invalidatedDirPrefixes) {
			this.removeSubtree(prefix)
		}
		for (const resolved of resolvedFiles.values()) {
			if (resolved.kind === 'dir-flip') {
				this.removeSubtree(resolved.stat.path)
			}
		}

		for (const item of deletes) {
			if (!item.isSelf) {
				const parentKey = this.normalizeDirPath(dirname(item.key))
				this.removeChildFromParent(parentKey, item.key)
			}
			this.clearUnreadableSubtree(item.key)
			if (item.entry.isDir) {
				this.removeSubtree(item.key)
				if (item.isSelf) {
					this.enqueueDirectory(this.remoteBaseDir)
				}
			}
		}

		for (const item of writes) {
			const resolved = resolvedFiles.get(item.key)
			if (item.entry.isDir || resolved?.kind === 'dir-flip') {
				this.clearUnreadable(item.key)
				if (!item.isSelf) {
					const parentKey = this.normalizeDirPath(dirname(item.key))
					const dirStat: StatModel =
						resolved?.kind === 'dir-flip'
							? resolved.stat
							: {
									path: item.key,
									basename: item.key.split('/').pop() || '',
									isDir: true,
									isDeleted: false,
								}
					this.upsertChildInParent(parentKey, dirStat)
				}
				this.enqueueDirectory(item.key)
				continue
			}

			if (item.isSelf) {
				continue
			}

			const parentKey = this.normalizeDirPath(dirname(item.key))
			if (!this.nodes[parentKey]) {
				const parentCoveredByQueue = this.queue.some((queued) =>
					parentKey.startsWith(this.normalizeDirPath(queued)),
				)
				if (!parentCoveredByQueue) {
					if (parentKey === this.normalizeDirPath(this.remoteBaseDir)) {
						this.enqueueDirectory(this.remoteBaseDir)
					} else {
						this.pendingVerification.add(parentKey)
						this.markDirty()
					}
				}
				continue
			}

			if (!resolved) {
				continue
			}

			if (resolved.kind === 'missing-verify') {
				this.pendingVerification.add(this.normalizeDirPath(resolved.path))
				this.markDirty()
				continue
			}

			if (resolved.kind === 'unreadable') {
				this.removeChildFromParent(parentKey, item.key)
				this.recordUnreadable(resolved.path, 'stat', resolved.status)
				continue
			}

			this.clearUnreadable(item.key)
			this.upsertChildInParent(parentKey, resolved.stat)
		}

		this.rootCursor = nextCursor
		this.processedChanges += entries.length
		this.discoveredCount = this.countDiscoveredItems()
		this.markDirty()
		this.emitProgress('incremental')
		return entries.length
	}

	/**
	 * Get all results from cache
	 */
	private getAllFromCache(): StatModel[] {
		const results: StatModel[] = []
		for (const items of Object.values(this.nodes)) {
			results.push(...items)
		}
		return results
	}

	private countDiscoveredItems(): number {
		return Object.values(this.nodes).reduce(
			(total, items) => total + items.length,
			0,
		)
	}

	/**
	 * Load state
	 */
	private async loadState(): Promise<void> {
		const cache = await traverseWebDAVKV.get(this.kvKey)
		if (cache) {
			if (!isTraversalCacheCompatible(cache, this.remoteBaseDir)) {
				logger.warn(
					'Discarding incompatible traversal cache for current remote directory',
				)
				await traverseWebDAVKV.unset(this.kvKey)
				this.rootCursor = ''
				this.queue = []
				this.pendingVerification.clear()
				this.unreadablePaths.clear()
				this.nodes = {}
				this.lastFullScanAt = undefined
				this.fullScanFromRoot = false
				this.dirty = false
				this.lastSavedAt = this.now()
				return
			}
			this.rootCursor = cache.rootCursor || ''
			this.queue = cache.queue || []
			this.pendingVerification = new Set(cache.pendingVerification ?? [])
			this.unreadablePaths = new Map(
				(cache.unreadablePaths ?? []).map((entry) => [
					this.normalizeForComparison(entry.path),
					entry,
				]),
			)
			this.nodes = cache.nodes || {}
			this.lastFullScanAt = cache.lastFullScanAt
			this.fullScanFromRoot = false
			this.processedCount = Object.keys(this.nodes).length
			this.discoveredCount = this.countDiscoveredItems()
			this.dirty = false
			this.lastSavedAt = this.now()
		}
	}

	/**
	 * Save current state when mutations have occurred since the last flush.
	 */
	private async saveState(options?: {
		allowWhenCancelled?: boolean
	}): Promise<void> {
		if (!this.dirty) return
		if (!options?.allowWhenCancelled) {
			this.checkCancelled()
		}
		await traverseWebDAVKV.set(this.kvKey, {
			schemaVersion: TRAVERSAL_CACHE_SCHEMA,
			rootCursor: this.rootCursor,
			queue: this.queue,
			pendingVerification: [...this.pendingVerification],
			...(this.unreadablePaths.size > 0
				? { unreadablePaths: [...this.unreadablePaths.values()] }
				: {}),
			nodes: this.nodes,
			lastFullScanAt: this.lastFullScanAt,
		})
		this.dirty = false
		this.lastSavedAt = this.now()
	}

	/**
	 * Check if cache is valid
	 */
	async isCacheValid(): Promise<boolean> {
		const cache = await traverseWebDAVKV.get(this.kvKey)
		if (!cache || !isTraversalCacheCompatible(cache, this.remoteBaseDir)) {
			return false
		}

		// A drained queue may still have unresolved 404 observations.
		return (
			cache.queue.length === 0 && (cache.pendingVerification?.length ?? 0) === 0
		)
	}
}
