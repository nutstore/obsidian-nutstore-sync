import { Vault } from 'obsidian'
import { isAbsolute, join, normalize } from 'path-browserify'
import type { NutstoreSettings } from '~/settings'
import {
	ConfigDirSyncMode,
	computeEffectiveFilterRulesFromParts,
} from '~/utils/config-dir-rules'
import { getTraversalWebDAVDBKey } from '~/utils/get-db-key'
import GlobMatch, {
	GlobMatchOptions,
	isVoidGlobMatchOptions,
	needIncludeFromGlobRules,
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
				exclusionRules: GlobMatchOptions[]
				inclusionRules: GlobMatchOptions[]
				configDir?: string
				configDirSyncMode?: ConfigDirSyncMode
			}
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
			saveInterval: 1,
			onProgress: this.options.onTraversalProgress,
			throwIfCancelled: this.options.throwIfCancelled,
		})
		const traversedStats = await traversal.traverse()

		if (traversedStats.length === 0) {
			return []
		}

		const base = normalizeRemotePath(stdRemotePath(this.options.remoteBaseDir))
		const statsByLocalPath = new Map<string, (typeof traversedStats)[number]>()
		for (const stat of traversedStats) {
			const absolutePath = normalizeRemotePath(
				isAbsolute(stat.path) ? stat.path : join(base, stat.path),
			)
			if (!isSub(base, absolutePath)) {
				continue
			}

			const localPath = absolutePath
				.slice(base === '/' ? 1 : base.length)
				.replace(/^\/+/, '')
			if (!statsByLocalPath.has(localPath)) {
				statsByLocalPath.set(localPath, { ...stat, path: localPath })
			}
		}
		const stats = [...statsByLocalPath.values()]

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
		const exclusions = this.buildRules(filterRules?.exclusionRules)
		const inclusions = this.buildRules(filterRules?.inclusionRules)

		const includedStats = stats.filter(
			(stat) =>
				!isSyncCacheLocalPath(stat.path, this.options.vault.configDir) &&
				needIncludeFromGlobRules(stat.path, inclusions, exclusions),
		)
		const completeStats = completeLossDir(stats, includedStats)
		const completeStatPaths = new Set(completeStats.map((s) => s.path))
		const results = stats.map((stat) => ({
			stat,
			ignored: !completeStatPaths.has(stat.path),
		}))
		return results
	}

	private buildRules(rules: GlobMatchOptions[] = []): GlobMatch[] {
		return rules
			.filter((opt) => !isVoidGlobMatchOptions(opt))
			.map(({ expr, options }) => new GlobMatch(expr, options))
	}
}

function normalizeRemotePath(path: string): string {
	const normalized = normalize(path)
	return normalized.length > 1 && normalized.endsWith('/')
		? normalized.slice(0, -1)
		: normalized
}
