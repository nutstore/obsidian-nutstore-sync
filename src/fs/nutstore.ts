import { Vault } from 'obsidian'
import { dirname, isAbsolute, join, normalize } from 'path-browserify'
import type { StatModel } from '~/model/stat.model'
import type { NutstoreSettings } from '~/settings'
import {
	ConfigDirSyncMode,
	computeEffectiveFilterRulesFromParts,
} from '~/utils/config-dir-rules'
import { getTraversalWebDAVDBKey } from '~/utils/get-db-key'
import {
	compileFilterRules,
	createPathInclusionChecker,
	GlobFilterRule,
} from '~/utils/glob-match'
import { isSub } from '~/utils/is-sub'
import { stdRemotePath } from '~/utils/std-remote-path'
import { isSyncCacheLocalPath } from '~/utils/sync-cache-file'
import { getNutstoreDavEndpoint } from '~/utils/nutstore-endpoints'
import {
	ResumableWebDAVTraversal,
	type WebDAVTraversalProgress,
} from '~/utils/traverse-webdav'
import AbstractFileSystem from './fs.interface'
import completeLossDir from './utils/complete-loss-dir'

export class NutstoreFileSystem implements AbstractFileSystem {
	constructor(
		private options: {
			vault: Vault
			settings: NutstoreSettings
			token: string
			remoteAccountId: string
			remoteBaseDir: string
			filterRules?: {
				rules: GlobFilterRule[]
				configDir?: string
				configDirSyncMode?: ConfigDirSyncMode
			}
			/** Skip filter compilation/evaluation when caller only queries post-task metadata. */
			skipFilter?: boolean
			/** Limit returned stats to these vault-relative paths (implies targeted directory lookup). */
			targetPaths?: ReadonlySet<string>
			onTraversalProgress?: (progress: WebDAVTraversalProgress) => void
			throwIfCancelled?: () => void
		},
	) {}

	async walk() {
		const traversal = new ResumableWebDAVTraversal({
			settings: this.options.settings,
			token: this.options.token,
			remoteBaseDir: this.options.remoteBaseDir,
			kvKey: await getTraversalWebDAVDBKey(
				this.options.remoteAccountId,
				getNutstoreDavEndpoint(this.options.settings),
				this.options.remoteBaseDir,
			),
			onProgress: this.options.onTraversalProgress,
			throwIfCancelled: this.options.throwIfCancelled,
		})
		const base = normalizeRemotePath(stdRemotePath(this.options.remoteBaseDir))
		const targetPaths = this.options.targetPaths

		let traversedStats: StatModel[]
		if (targetPaths) {
			const parentDirs = new Set<string>()
			for (const localPath of targetPaths) {
				const absTarget = normalizeRemotePath(join(base, localPath))
				if (!isSub(base, absTarget)) continue
				const parent = normalizeRemotePath(dirname(absTarget))
				parentDirs.add(stdRemotePath(parent))
			}
			traversedStats = await traversal.syncAndLookupDirs(parentDirs)
		} else {
			traversedStats = await traversal.traverse()
		}

		if (traversedStats.length === 0) {
			return []
		}

		const statsByLocalPath = new Map<string, StatModel>()
		for (const stat of traversedStats) {
			const normalized = toLocalStat(base, stat)
			if (!normalized) continue
			if (targetPaths && !targetPaths.has(normalized.path)) {
				continue
			}
			if (!statsByLocalPath.has(normalized.path)) {
				statsByLocalPath.set(normalized.path, normalized)
			}
		}
		const stats = [...statsByLocalPath.values()]

		if (this.options.skipFilter) {
			return stats.map((stat) => ({ stat, ignored: false }))
		}

		const settings = this.options.filterRules
			? undefined
			: this.options.settings
		const filterRules =
			this.options.filterRules ??
			(settings
				? computeEffectiveFilterRulesFromParts(
						this.options.vault.configDir,
						settings.configDirSyncMode ?? 'none',
						settings.filterRules,
					)
				: undefined)
		const checkIncluded = createPathInclusionChecker(
			compileFilterRules(filterRules?.rules),
		)

		const includedStats = stats.filter(
			(stat) =>
				!isSyncCacheLocalPath(stat.path, this.options.vault.configDir) &&
				checkIncluded(stat.path, stat.isDir),
		)
		const completeStats = completeLossDir(stats, includedStats)
		const completeStatPaths = new Set(completeStats.map((s) => s.path))
		const results = stats.map((stat) => ({
			stat,
			ignored: !completeStatPaths.has(stat.path),
		}))
		return results
	}
}

function toLocalStat(base: string, stat: StatModel): StatModel | undefined {
	const absolutePath = normalizeRemotePath(
		isAbsolute(stat.path) ? stat.path : join(base, stat.path),
	)
	if (!isSub(base, absolutePath)) {
		return undefined
	}
	const localPath = absolutePath
		.slice(base === '/' ? 1 : base.length)
		.replace(/^\/+/, '')
	return { ...stat, path: localPath }
}

function normalizeRemotePath(path: string): string {
	const normalized = normalize(path)
	return normalized.length > 1 && normalized.endsWith('/')
		? normalized.slice(0, -1)
		: normalized
}
