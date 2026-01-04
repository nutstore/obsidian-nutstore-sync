import { isArray } from 'lodash-es'
import { Vault } from 'obsidian'
import { isAbsolute } from 'path-browserify'
import { isNotNil } from 'ramda'
import { createClient, WebDAVClient } from 'webdav'
import { getDelta } from '~/api/delta'
import { NS_DAV_ENDPOINT } from '~/consts'
import { useSettings } from '~/settings'
import { deltaCacheKV } from '~/storage'
import { applyDeltasToStats } from '~/utils/apply-deltas-to-stats'
import { getDBKey } from '~/utils/get-db-key'
import { getRootFolderName } from '~/utils/get-root-folder-name'
import GlobMatch, {
	extendRules,
	GlobMatchOptions,
	isVoidGlobMatchOptions,
	needIncludeFromGlobRules,
} from '~/utils/glob-match'
import { isSub } from '~/utils/is-sub'
import { stdRemotePath } from '~/utils/std-remote-path'
import { ResumableWebDAVTraversal } from '~/utils/traverse-webdav'
import AbstractFileSystem from './fs.interface'
import completeLossDir from './utils/complete-loss-dir'

export class NutstoreFileSystem implements AbstractFileSystem {
	private webdav: WebDAVClient

	constructor(
		private options: {
			vault: Vault
			token: string
			remoteBaseDir: string
		},
	) {
		this.webdav = createClient(NS_DAV_ENDPOINT, {
			headers: {
				Authorization: `Basic ${this.options.token}`,
			},
		})
	}

	private async resetDeltaCache() {
		const traversal = new ResumableWebDAVTraversal({
			token: this.options.token,
			remoteBaseDir: this.options.remoteBaseDir,
			kvKey: getDBKey(this.options.vault.getName(), this.options.remoteBaseDir),
			saveInterval: 1,
		})
		const files = await traversal.traverse()
		const originCursor = traversal.cursor
		return {
			files,
			originCursor,
			deltas: [],
		}
	}

	async walk() {
		const kvKey = getDBKey(
			this.options.vault.getName(),
			this.options.remoteBaseDir,
		)
		let deltaCache = await deltaCacheKV.get(kvKey)
		if (deltaCache) {
			let cursor = deltaCache.deltas.at(-1)?.cursor ?? deltaCache.originCursor
			while (true) {
				const { response } = await getDelta({
					token: this.options.token,
					cursor,
					folderName: getRootFolderName(this.options.remoteBaseDir),
				})
				if (response.cursor === cursor) {
					break
				}
				if (response.reset) {
					deltaCache = await this.resetDeltaCache()
					cursor = deltaCache.originCursor
				} else if (response.delta.entry) {
					if (!isArray(response.delta.entry)) {
						response.delta.entry = [response.delta.entry]
					}
					if (response.delta.entry.length > 0) {
						deltaCache.deltas.push(response)
					}
					if (response.hasMore) {
						cursor = response.cursor
					} else {
						break
					}
				} else {
					break
				}
			}
		} else {
			deltaCache = await this.resetDeltaCache()
		}

		await deltaCacheKV.set(kvKey, deltaCache)

		// Apply deltas to files
		const allDeltas = deltaCache.deltas.flatMap((d) => d.delta.entry)
		let stats =
			allDeltas.length === 0
				? deltaCache.files
				: applyDeltasToStats(deltaCache.files, allDeltas)
		{
			const lastDelta = deltaCache.deltas.at(-1)
			if (lastDelta) {
				const latestCursor = lastDelta.cursor
				deltaCache.files = stats
				deltaCache.deltas = []
				deltaCache.originCursor = latestCursor
				await deltaCacheKV.set(kvKey, deltaCache)
			}
		}

		if (stats.length === 0) {
			return []
		}

		const base = stdRemotePath(this.options.remoteBaseDir)
		const subPath = new Set<string>()
		for (let { path } of stats) {
			if (path.endsWith('/')) {
				path = path.slice(0, path.length - 1)
			}
			if (!path.startsWith('/')) {
				path = `/${path}`
			}
			if (isSub(base, path)) {
				subPath.add(path)
			}
		}

		const statsMap = new Map(stats.map((s) => [s.path, s]))
		stats = [...subPath].map((path) => statsMap.get(path)).filter(isNotNil)
		for (const item of stats) {
			if (isAbsolute(item.path)) {
				item.path = item.path.replace(this.options.remoteBaseDir, '')
				if (item.path.startsWith('/')) {
					item.path = item.path.slice(1)
				}
			}
		}

		const settings = await useSettings()
		const exclusions = this.buildRules(settings?.filterRules.exclusionRules)
		const inclusions = this.buildRules(settings?.filterRules.inclusionRules)

		const includedStats = stats.filter((stat) =>
			needIncludeFromGlobRules(stat.path, inclusions, exclusions),
		)
		const completeStats = completeLossDir(stats, includedStats)
		const completeStatPaths = new Set(completeStats.map((s) => s.path))
		return stats.map((stat) => ({
			stat,
			ignored: !completeStatPaths.has(stat.path),
		}))
	}

	private buildRules(rules: GlobMatchOptions[] = []): GlobMatch[] {
		return extendRules(
			rules
				.filter((opt) => !isVoidGlobMatchOptions(opt))
				.map(({ expr, options }) => new GlobMatch(expr, options)),
		)
	}
}
