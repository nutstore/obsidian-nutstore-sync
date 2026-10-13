import { Mutex } from 'async-mutex'
import { dirname, normalize } from 'path-browserify'
import { DeltaEntry, getDelta } from '~/api/delta'
import { getLatestDeltaCursor } from '~/api/latestDeltaCursor'
import { getDirectoryContents } from '~/api/webdav'
import { StatModel } from '~/model/stat.model'
import type { NutstoreSettings } from '~/settings'
import { traverseWebDAVKV } from '~/storage'
import { apiLimiter } from './api-limiter'
import { fileStatToStatModel } from './file-stat-to-stat-model'
import { getRootFolderName } from './get-root-folder-name'
import { is503Error } from './is-503-error'
import logger from './logger'
import { RequestUrlError } from './request-url-error'
import sleep from './sleep'
import { stdRemotePath } from './std-remote-path'
import { isTraversalCacheCompatible } from './traversal-cache-compat'
import { MaybePromise } from './types'

const getContents = (
	settings: NutstoreSettings,
	token: string,
	path: string,
	check?: () => void,
) =>
	apiLimiter.schedule(() => getDirectoryContents(settings, token, path, check))

// Global mutex map: one lock per kvKey
const traversalLocks = new Map<string, Mutex>()

function getTraversalLock(kvKey: string): Mutex {
	if (!traversalLocks.has(kvKey)) {
		traversalLocks.set(kvKey, new Mutex())
	}
	return traversalLocks.get(kvKey)!
}

async function executeWithRetry<T>(
	func: () => MaybePromise<T>,
	options: {
		onRetry?: () => void
		throwIfCancelled?: () => void
	} = {},
): Promise<T> {
	while (true) {
		options.throwIfCancelled?.()
		try {
			return await func()
		} catch (err) {
			const normalizedError =
				err instanceof Error || typeof err === 'string'
					? err
					: new Error(String(err))
			if (is503Error(normalizedError)) {
				options.onRetry?.()
				for (let waited = 0; waited < 30_000; waited += 500) {
					options.throwIfCancelled?.()
					await sleep(500)
				}
			} else {
				throw err
			}
		}
	}
}

export interface WebDAVTraversalProgress {
	phase: 'scanning' | 'incremental' | 'retrying' | 'complete'
	currentPath?: string
	processedDirectories: number
	queuedDirectories: number
	discoveredItems: number
	processedChanges: number
}

export class ResumableWebDAVTraversal {
	private token: string
	private remoteBaseDir: string
	private kvKey: string
	private saveInterval: number
	private settings: NutstoreSettings
	private onProgress?: (progress: WebDAVTraversalProgress) => void
	private throwIfCancelled?: () => void

	private rootCursor: string = ''
	private queue: string[] = []
	// A 404 is incomplete observation, never proof of deletion. Persist until reconciled.
	private pendingVerification = new Set<string>()
	private nodes: Record<string, StatModel[]> = {}
	private processedCount: number = 0
	private discoveredCount: number = 0
	private processedChanges: number = 0

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
		onProgress?: (progress: WebDAVTraversalProgress) => void
		throwIfCancelled?: () => void
	}) {
		this.settings = options.settings
		this.token = options.token
		this.remoteBaseDir = options.remoteBaseDir
		this.kvKey = options.kvKey
		this.saveInterval = Math.max(options.saveInterval || 1, 1)
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
		return executeWithRetry(func, {
			throwIfCancelled: this.throwIfCancelled,
			onRetry: () => this.emitProgress('retrying', currentPath),
		})
	}

	get lock() {
		return getTraversalLock(this.kvKey)
	}

	get cursor(): string {
		return this.rootCursor
	}

	async traverse(): Promise<StatModel[]> {
		return await this.lock.runExclusive(async () => {
			this.checkCancelled()
			await this.loadState()

			// Use incremental scan if already traversed once
			const isIncrementalScan =
				this.queue.length === 0 &&
				this.pendingVerification.size === 0 &&
				Object.keys(this.nodes).length > 0

			try {
				if (isIncrementalScan) {
					await this.incrementalScan()
				} else {
					// Initial scan or resume: BFS traversal
					if (this.queue.length === 0 && this.pendingVerification.size === 0) {
						const { response } = await this.executeWithRetry(() =>
							getLatestDeltaCursor({
								token: this.token,
								throwIfCancelled: this.throwIfCancelled,
								settings: this.settings,
								folderName: getRootFolderName(this.remoteBaseDir),
							}),
						)
						this.rootCursor = response.cursor
						this.queue = [this.remoteBaseDir]
					}

					await this.bfsTraverse()
				}
			} finally {
				await this.saveState()
			}
			this.emitProgress('complete')

			return this.getAllFromCache()
		})
	}

	/**
	 * BFS traversal (initial scan or resume)
	 */
	private async bfsTraverse(): Promise<StatModel[]> {
		// Remember paths across repairs and subtree invalidation within this invocation.
		// Normal scans may need any number of passes; the same unresolved directory
		// must not cycle through verification -> BFS -> verification indefinitely.
		const suspendedDirectories = new Set(this.pendingVerification)
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
						const contents = await this.executeWithRetry(
							() =>
								getContents(
									this.settings,
									this.token,
									currentPath,
									this.throwIfCancelled,
								),
							currentPath,
						)

						for (const item of contents) {
							const stat = fileStatToStatModel(item)
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
					this.processedCount++
					this.emitProgress('scanning', currentPath)

					if (this.processedCount % this.saveInterval === 0) {
						await this.saveState()
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
						continue
					}
					logger.error(`Error processing ${currentPath}`, err)
					await this.saveState()
					throw err
				}
			}

			const { response: endResponse } = await this.executeWithRetry(() =>
				getLatestDeltaCursor({
					token: this.token,
					throwIfCancelled: this.throwIfCancelled,
					settings: this.settings,
					folderName: getRootFolderName(this.remoteBaseDir),
				}),
			)
			const traverseEndCursor = endResponse.cursor

			if (traverseStartCursor && traverseStartCursor !== traverseEndCursor) {
				this.rootCursor =
					await this.applyDeltaDuringTraversal(traverseStartCursor)
			} else {
				this.rootCursor = traverseEndCursor
			}

			const refreshed =
				await this.reconcilePendingDirectories(suspendedDirectories)
			if (
				!refreshed &&
				this.queue.length === 0 &&
				this.pendingVerification.size === 0
			) {
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
		}
	}

	/** Invalidate an absent or untrusted subtree, including its unfinished work. */
	private removeSubtree(path: string): void {
		const prefix = this.normalizeDirPath(path)
		for (const key of Object.keys(this.nodes)) {
			if (this.normalizeDirPath(key).startsWith(prefix)) delete this.nodes[key]
		}
		this.queue = this.queue.filter(
			(item) => !this.normalizeDirPath(item).startsWith(prefix),
		)
		for (const item of this.pendingVerification) {
			if (item.startsWith(prefix)) this.pendingVerification.delete(item)
		}
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
				try {
					contents = (
						await this.executeWithRetry(
							() =>
								getContents(
									this.settings,
									this.token,
									parent,
									this.throwIfCancelled,
								),
							parent,
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
					)
						this.removeSubtree(path)
				}
				this.nodes[parent] = contents
				this.pendingVerification.delete(parent)
				for (const path of directories) {
					if (this.pendingVerification.has(path)) {
						// An absent/recreated ancestor invalidates its entire old subtree.
						this.removeSubtree(path)
						this.pendingVerification.add(path)
					}
					this.enqueueDirectory(path)
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
				this.nodes = {}
				this.pendingVerification.clear()
				this.queue = [this.remoteBaseDir]
				this.processedCount = 0
				const { response: cursorResponse } = await this.executeWithRetry(() =>
					getLatestDeltaCursor({
						token: this.token,
						throwIfCancelled: this.throwIfCancelled,
						settings: this.settings,
						folderName: getRootFolderName(this.remoteBaseDir),
					}),
				)
				this.rootCursor = cursorResponse.cursor
				return this.rootCursor
			}

			if (entries.length > 0) {
				processedEntries += this.applyDeltaEntries(entries)
				this.rootCursor = cursor

				// Save state periodically based on number of processed entries
				if (processedEntries >= this.saveInterval) {
					await this.saveState()
					processedEntries = 0
				}
			}

			finalCursor = cursor
			this.rootCursor = cursor
		}

		await this.saveState()

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

	/**
	 * Apply delta changes to nodes
	 */
	private applyDeltaToNodes(entries: Array<DeltaEntry>): void {
		// Prepare baseDir prefix for filtering
		const baseDirPrefix = this.remoteBaseDir.endsWith('/')
			? this.remoteBaseDir
			: this.remoteBaseDir + '/'

		// Sort by path length to process parents first
		const sortedEntries = [...entries].sort(
			(a, b) => a.path.length - b.path.length,
		)

		for (const entry of sortedEntries) {
			// Filter out changes that don't belong to remoteBaseDir scope
			const normalizedBaseDir = this.normalizeDirPath(this.remoteBaseDir)
			const normalizedEntryPath = this.normalizeDirPath(entry.path)
			const isSelf = normalizedEntryPath === normalizedBaseDir
			const isChild = entry.path.startsWith(baseDirPrefix)

			if (!isSelf && !isChild) {
				continue
			}
			if (entry.isDir) {
				if (entry.isDeleted) {
					const parentPath = dirname(this.normalizeForComparison(entry.path))
					if (parentPath) {
						const normalizedParentPath = this.normalizeDirPath(parentPath)
						const parentItems = this.nodes[normalizedParentPath]
						if (parentItems) {
							const normalizedEntryPathForCmp = this.normalizeForComparison(
								entry.path,
							)
							this.nodes[normalizedParentPath] = parentItems.filter(
								(item) =>
									this.normalizeForComparison(item.path) !==
									normalizedEntryPathForCmp,
							)
						}
					}

					this.removeSubtree(entry.path)
					if (isSelf) this.enqueueDirectory(this.remoteBaseDir)
				} else {
					const parentPath = dirname(this.normalizeForComparison(entry.path))

					// Only update parent's children list if parent already exists
					// (Avoid creating incomplete parent records)
					if (parentPath) {
						const normalizedParentPath = this.normalizeDirPath(parentPath)
						const parentItems = this.nodes[normalizedParentPath]

						if (parentItems) {
							const dirStat: StatModel = {
								path: entry.path,
								basename: entry.path.split('/').pop() || '',
								isDir: true,
								isDeleted: false,
								mtime: entry.modified
									? new Date(entry.modified).getTime()
									: undefined,
							}

							const normalizedEntryPathForCmp = this.normalizeForComparison(
								entry.path,
							)
							this.nodes[normalizedParentPath] = [
								...parentItems.filter(
									(item) =>
										this.normalizeForComparison(item.path) !==
										normalizedEntryPathForCmp,
								),
								dirStat,
							]
						}
					}

					this.enqueueDirectory(entry.path)
				}
			} else {
				// is file
				const parentPath = dirname(this.normalizeForComparison(entry.path))

				// Only update parent's children list if parent exists
				if (parentPath) {
					const normalizedParentPath = this.normalizeDirPath(parentPath)
					if (entry.isDeleted) {
						const parentItems = this.nodes[normalizedParentPath]
						if (parentItems) {
							const normalizedEntryPathForCmp = this.normalizeForComparison(
								entry.path,
							)
							this.nodes[normalizedParentPath] = parentItems.filter(
								(item) =>
									this.normalizeForComparison(item.path) !==
									normalizedEntryPathForCmp,
							)
						}
					} else {
						// Only update if parent directory already exists in cache
						// (Avoid creating incomplete parent records that would hide other files)
						const parentItems = this.nodes[normalizedParentPath]

						if (parentItems) {
							const stat: StatModel = {
								path: entry.path,
								basename: entry.path.split('/').pop() || '',
								isDir: false,
								isDeleted: false,
								mtime: new Date(entry.modified).getTime(),
								size: entry.size,
							}

							const normalizedEntryPathForCmp = this.normalizeForComparison(
								entry.path,
							)
							this.nodes[normalizedParentPath] = [
								...parentItems.filter(
									(item) =>
										this.normalizeForComparison(item.path) !==
										normalizedEntryPathForCmp,
								),
								stat,
							]
						}
					}
				}
			}
		}
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

	private applyDeltaEntries(entries: DeltaEntry[]): number {
		this.applyDeltaToNodes(entries)
		this.processedChanges += entries.length
		this.discoveredCount = this.countDiscoveredItems()
		this.emitProgress('incremental')
		return entries.length
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
				this.nodes = {}
				return
			}
			this.rootCursor = cache.rootCursor || ''
			this.queue = cache.queue || []
			this.pendingVerification = new Set(cache.pendingVerification ?? [])
			this.nodes = cache.nodes || {}
			this.processedCount = Object.keys(this.nodes).length
			this.discoveredCount = this.countDiscoveredItems()
		}
	}

	/**
	 * Save current state
	 */
	private async saveState(): Promise<void> {
		this.checkCancelled()
		await traverseWebDAVKV.set(this.kvKey, {
			rootCursor: this.rootCursor,
			queue: this.queue,
			pendingVerification: [...this.pendingVerification],
			nodes: this.nodes,
		})
	}

	/**
	 * Clear cache (force re-traversal)
	 */
	async clearCache(): Promise<void> {
		await traverseWebDAVKV.unset(this.kvKey)
		this.rootCursor = ''
		this.queue = []
		this.pendingVerification.clear()
		this.nodes = {}
		this.processedCount = 0
		this.discoveredCount = 0
		this.processedChanges = 0
	}

	/**
	 * Check if cache is valid
	 */
	async isCacheValid(): Promise<boolean> {
		const cache = await traverseWebDAVKV.get(this.kvKey)
		if (!cache) {
			return false
		}

		// A drained queue may still have unresolved 404 observations.
		return (
			cache.queue.length === 0 && (cache.pendingVerification?.length ?? 0) === 0
		)
	}
}
