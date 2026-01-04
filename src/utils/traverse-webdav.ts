import { Mutex } from 'async-mutex'
import { dirname } from 'path-browserify'
import { DeltaEntry, getDelta } from '~/api/delta'
import { getLatestDeltaCursor } from '~/api/latestDeltaCursor'
import { getDirectoryContents } from '~/api/webdav'
import { StatModel } from '~/model/stat.model'
import { traverseWebDAVKV } from '~/storage'
import { apiLimiter } from './api-limiter'
import { fileStatToStatModel } from './file-stat-to-stat-model'
import { getRootFolderName } from './get-root-folder-name'
import { is503Error } from './is-503-error'
import sleep from './sleep'
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

			let results: StatModel[] = []

			// Use incremental scan if already traversed once
			const isIncrementalScan =
				this.queue.length === 0 && Object.keys(this.nodes).length > 0

			if (isIncrementalScan) {
				results = await this.incrementalScan()
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

				results = await this.bfsTraverse()
			}

			await this.saveState()

			return results
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
				const resultItems: StatModel[] = []

				try {
					const cachedItems = this.nodes[currentPath]

					// Use cached items if available for resume
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

					this.nodes[currentPath] = resultItems

					this.queue.shift()
					this.processedCount++

					if (this.processedCount % this.saveInterval === 0) {
						await this.saveState()
					}
				} catch (err) {
					console.error(`Error processing ${currentPath}`, err)
					// Save state before throwing for resume capability
					await this.saveState()
					throw err
				}
			}

			// Check for changes during traversal
			const { response: endResponse } = await executeWithRetry(() =>
				getLatestDeltaCursor({
					token: this.token,
					folderName: getRootFolderName(this.remoteBaseDir),
				}),
			)
			const traverseEndCursor = endResponse.cursor

			// Cursor changed, apply delta updates
			if (traverseStartCursor && traverseStartCursor !== traverseEndCursor) {
				console.log('Changes detected during traversal, applying delta')
				const newCursor =
					await this.applyDeltaDuringTraversal(traverseStartCursor)
				this.rootCursor = newCursor

				// If reset occurred, queue is non-empty, need to re-traverse
				if (this.queue.length > 0) {
					console.log(
						'Reset detected during delta apply, performing full re-scan',
					)
					continue // Restart traversal instead of recursion
				}

				return this.getAllFromCache()
			}

			this.rootCursor = traverseEndCursor

			return results
		}
	}

	/**
	 * Apply changes during traversal without re-scanning
	 * Returns the new cursor. If reset occurred, clears cache and sets queue for re-scan.
	 */
	private async applyDeltaDuringTraversal(
		startCursor: string,
	): Promise<string> {
		const { response } = await executeWithRetry(() =>
			getDelta({
				token: this.token,
				folderName: getRootFolderName(this.remoteBaseDir),
				cursor: startCursor,
			}),
		)

		if (response.reset) {
			console.warn(
				'Delta reset during traversal, clearing cache and will trigger full re-scan',
			)
			this.nodes = {}
			this.queue = [this.remoteBaseDir]
			// Get fresh cursor after reset
			const { response: cursorResponse } = await executeWithRetry(() =>
				getLatestDeltaCursor({
					token: this.token,
					folderName: getRootFolderName(this.remoteBaseDir),
				}),
			)
			return cursorResponse.cursor
		}

		this.applyDeltaToNodes(response.delta.entry)
		return response.cursor
	}

	/**
	 * Incremental scan using getDelta
	 */
	private async incrementalScan(): Promise<StatModel[]> {
		const { response } = await executeWithRetry(() =>
			getDelta({
				token: this.token,
				folderName: getRootFolderName(this.remoteBaseDir),
				cursor: this.rootCursor,
			}),
		)

		this.rootCursor = response.cursor

		// Full scan required if reset
		if (response.reset) {
			console.log('Delta reset, performing full scan')
			this.queue = [this.remoteBaseDir]
			this.nodes = {}
			return await this.bfsTraverse()
		}

		// Return from cache if no changes
		if (response.delta.entry.length === 0) {
			console.log('No changes detected, returning from cache')
			return this.getAllFromCache()
		}

		this.applyDeltaToNodes(response.delta.entry)

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
			const isSelf = entry.path === this.remoteBaseDir
			const isChild = entry.path.startsWith(baseDirPrefix)

			if (!isSelf && !isChild) {
				continue
			}
			if (entry.isDir) {
				if (entry.isDeleted) {
					const parentPath = dirname(entry.path)
					if (parentPath) {
						const parentItems = this.nodes[parentPath]
						if (parentItems) {
							this.nodes[parentPath] = parentItems.filter(
								(item) => item.path !== entry.path,
							)
						}
					}

					// Delete directory and all subdirectories
					for (const nodePath in this.nodes) {
						if (
							nodePath === entry.path ||
							nodePath.startsWith(entry.path + '/')
						) {
							delete this.nodes[nodePath]
						}
					}
				} else {
					const parentPath = dirname(entry.path)

					// Only update parent's children list if parent exists
					// (Avoid self-reference when entry.path is at root level)
					if (parentPath) {
						const parentItems = this.nodes[parentPath]

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

							// Replace entry
							this.nodes[parentPath] = [
								...parentItems.filter((item) => item.path !== entry.path),
								dirStat,
							]
						}
					}

					if (!this.nodes[entry.path]) {
						this.nodes[entry.path] = []
					}
				}
			} else {
				const parentPath = dirname(entry.path)

				// Only update parent's children list if parent exists
				if (parentPath) {
					const parentItems = this.nodes[parentPath]

					if (parentItems) {
						if (entry.isDeleted) {
							this.nodes[parentPath] = parentItems.filter(
								(item) => item.path !== entry.path,
							)
						} else {
							const stat: StatModel = {
								path: entry.path,
								basename: entry.path.split('/').pop() || '',
								isDir: false,
								isDeleted: false,
								mtime: new Date(entry.modified).getTime(),
								size: entry.size,
							}

							// Replace entry
							this.nodes[parentPath] = [
								...parentItems.filter((item) => item.path !== entry.path),
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
			this.processedCount = cache.processedCount || 0
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
			processedCount: this.processedCount,
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
