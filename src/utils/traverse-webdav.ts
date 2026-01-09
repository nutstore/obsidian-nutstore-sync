import { Mutex } from 'async-mutex'
import { dirname, normalize } from 'path-browserify'
import { DeltaEntry, getDelta } from '~/api/delta'
import { getLatestDeltaCursor } from '~/api/latestDeltaCursor'
import { getDirectoryContents } from '~/api/webdav'
import { StatModel } from '~/model/stat.model'
import { traverseWebDAVKV } from '~/storage'
import { apiLimiter } from './api-limiter'
import { fileStatToStatModel } from './file-stat-to-stat-model'
import { getRootFolderName } from './get-root-folder-name'
import { is503Error } from './is-503-error'
import logger from './logger'
import sleep from './sleep'
import { stdRemotePath } from './std-remote-path'
import { MaybePromise } from './types'

const getContents = apiLimiter.wrap(getDirectoryContents)

// Global mutex map: one lock per kvKey
const traversalLocks = new Map<string, Mutex>()

function getTraversalLock(kvKey: string): Mutex {
	if (!traversalLocks.has(kvKey)) {
		traversalLocks.set(kvKey, new Mutex())
	}
	return traversalLocks.get(kvKey)!
}

async function executeWithRetry<T>(func: () => MaybePromise<T>): Promise<T> {
	while (true) {
		try {
			return await func()
		} catch (err) {
			if (is503Error(err)) {
				await sleep(30_000)
			} else {
				throw err
			}
		}
	}
}

export class ResumableWebDAVTraversal {
	private token: string
	private remoteBaseDir: string
	private kvKey: string
	private saveInterval: number

	private rootCursor: string = ''
	private queue: string[] = []
	private nodes: Record<string, StatModel[]> = {}
	private processedCount: number = 0

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
		token: string
		remoteBaseDir: string
		kvKey: string
		saveInterval?: number
	}) {
		this.token = options.token
		this.remoteBaseDir = options.remoteBaseDir
		this.kvKey = options.kvKey
		this.saveInterval = Math.max(options.saveInterval || 1, 1)
	}

	get lock() {
		return getTraversalLock(this.kvKey)
	}

	get cursor(): string {
		return this.rootCursor
	}

	async traverse(): Promise<StatModel[]> {
		return await this.lock.runExclusive(async () => {
			await this.loadState()

			// Use incremental scan if already traversed once
			const isIncrementalScan =
				this.queue.length === 0 && Object.keys(this.nodes).length > 0

			if (isIncrementalScan) {
				await this.incrementalScan()
			} else {
				// Initial scan or resume: BFS traversal
				if (this.queue.length === 0) {
					const { response } = await executeWithRetry(() =>
						getLatestDeltaCursor({
							token: this.token,
							folderName: getRootFolderName(this.remoteBaseDir),
						}),
					)
					this.rootCursor = response.cursor
					this.queue = [this.remoteBaseDir]
				}

				await this.bfsTraverse()
			}

			await this.saveState()

			return this.getAllFromCache()
		})
	}

	/**
	 * BFS traversal (initial scan or resume)
	 */
	private async bfsTraverse(): Promise<StatModel[]> {
		// Outer loop to handle reset scenarios without recursion
		while (true) {
			const traverseStartCursor = this.rootCursor
			const results: StatModel[] = []

			while (this.queue.length > 0) {
				const currentPath = this.queue[0]
				const normalizedPath = this.normalizeDirPath(currentPath)
				const resultItems: StatModel[] = []

				try {
					const cachedItems = this.nodes[normalizedPath]

					if (cachedItems) {
						resultItems.push(...cachedItems)
					} else {
						const contents = await executeWithRetry(() =>
							getContents(this.token, currentPath),
						)

						for (const item of contents) {
							const stat = fileStatToStatModel(item)
							resultItems.push(stat)
						}
					}

					results.push(...resultItems)

					for (const item of resultItems) {
						if (item.isDir) {
							this.queue.push(item.path)
						}
					}

					this.nodes[normalizedPath] = resultItems

					this.queue.shift()
					this.processedCount++

					if (this.processedCount % this.saveInterval === 0) {
						await this.saveState()
					}
				} catch (err) {
					logger.error(`Error processing ${currentPath}`, err)
					await this.saveState()
					throw err
				}
			}

			const { response: endResponse } = await executeWithRetry(() =>
				getLatestDeltaCursor({
					token: this.token,
					folderName: getRootFolderName(this.remoteBaseDir),
				}),
			)
			const traverseEndCursor = endResponse.cursor

			if (traverseStartCursor && traverseStartCursor !== traverseEndCursor) {
				logger.info('Changes detected during traversal, applying delta')
				const newCursor =
					await this.applyDeltaDuringTraversal(traverseStartCursor)
				this.rootCursor = newCursor

				// If reset occurred, queue is non-empty, need to re-traverse
				if (this.queue.length > 0) {
					logger.info(
						'Reset detected during delta apply, performing full re-scan',
					)
					continue
				}

				return this.getAllFromCache()
			}

			this.rootCursor = traverseEndCursor

			return results
		}
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
			const { response } = await executeWithRetry(() =>
				getDelta({
					token: this.token,
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
			if (reset) {
				logger.warn(
					'Delta reset during traversal, clearing cache and will trigger full re-scan',
				)
				this.nodes = {}
				this.queue = [this.remoteBaseDir]
				this.processedCount = 0
				const { response: cursorResponse } = await executeWithRetry(() =>
					getLatestDeltaCursor({
						token: this.token,
						folderName: getRootFolderName(this.remoteBaseDir),
					}),
				)
				return cursorResponse.cursor
			}

			if (entries.length > 0) {
				this.applyDeltaToNodes(entries)
				processedEntries += entries.length

				// Save state periodically based on number of processed entries
				if (processedEntries >= this.saveInterval) {
					await this.saveState()
					processedEntries = 0
				}
			}

			finalCursor = cursor
		}

		await this.saveState()

		return finalCursor
	}

	/**
	 * Incremental scan using fetchAllDelta
	 */
	private async incrementalScan(): Promise<StatModel[]> {
		let hasAnyEntries = false
		let processedEntries = 0

		for await (const deltas of this.fetchAllDelta(this.rootCursor)) {
			const { entries, cursor, reset } = deltas

			this.rootCursor = cursor

			if (reset) {
				logger.info('Delta reset, performing full scan')
				this.queue = [this.remoteBaseDir]
				this.nodes = {}
				this.processedCount = 0
				return await this.bfsTraverse()
			}

			if (entries.length > 0) {
				hasAnyEntries = true
				this.applyDeltaToNodes(entries)
				processedEntries += entries.length

				// Save state periodically based on number of processed entries
				if (processedEntries >= this.saveInterval) {
					await this.saveState()
					processedEntries = 0
				}
			}
		}

		await this.saveState()

		if (!hasAnyEntries) {
			logger.info('No changes detected, returning from cache')
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
					const parentPath = dirname(entry.path)
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

					for (const nodePath in this.nodes) {
						if (
							nodePath === normalizedEntryPath ||
							nodePath.startsWith(normalizedEntryPath)
						) {
							delete this.nodes[nodePath]
						}
					}
				} else {
					const parentPath = dirname(entry.path)

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

					if (!this.nodes[normalizedEntryPath]) {
						this.nodes[normalizedEntryPath] = []
					}
				}
			} else {
				// is file
				const parentPath = dirname(entry.path)

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

	/**
	 * Load state
	 */
	private async loadState(): Promise<void> {
		const cache = await traverseWebDAVKV.get(this.kvKey)
		if (cache) {
			this.rootCursor = cache.rootCursor || ''
			this.queue = cache.queue || []
			this.nodes = cache.nodes || {}
		}
	}

	/**
	 * Save current state
	 */
	private async saveState(): Promise<void> {
		await traverseWebDAVKV.set(this.kvKey, {
			rootCursor: this.rootCursor,
			queue: this.queue,
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
		this.nodes = {}
		this.processedCount = 0
	}

	/**
	 * Check if cache is valid
	 */
	async isCacheValid(): Promise<boolean> {
		const cache = await traverseWebDAVKV.get(this.kvKey)
		if (!cache) {
			return false
		}

		// Cache is valid if queue is empty (traversal completed)
		return cache.queue.length === 0
	}
}
