import { Vault } from 'obsidian'
import { isAbsolute, join, normalize } from 'path-browserify'
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
import type { ScanIssue } from '~/sync/scope'
import {
	ResumableWebDAVTraversal,
	type WebDAVTraversalProgress,
} from '~/utils/traverse-webdav'
import AbstractFileSystem from './fs.interface'
import completeLossDir from './utils/complete-loss-dir'

export class NutstoreFileSystem implements AbstractFileSystem {
	issues: ScanIssue[] = []

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
			onTraversalProgress?: (progress: WebDAVTraversalProgress) => void
			throwIfCancelled?: () => void
		},
	) {}

	async walk() {
		this.issues = []
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

		const traversedStats = await traversal.traverse()

		for (const entry of traversal.getUnreadableEntries()) {
			const localPath = toLocalPath(base, entry.path)
			if (localPath === undefined) continue
			if (isSyncCacheLocalPath(localPath, this.options.vault.configDir)) {
				continue
			}
			this.issues.push({
				path: localPath,
				operation: entry.operation,
				cause: new Error(
					entry.status
						? `Remote PROPFIND failed (${entry.status}): ${entry.path}`
						: `Remote PROPFIND entry unreadable: ${entry.path}`,
				),
			})
		}

		if (traversedStats.length === 0) {
			return []
		}

		const statsByLocalPath = new Map<string, StatModel>()
		for (const stat of traversedStats) {
			const normalized = toLocalStat(base, stat)
			if (!normalized) continue
			if (!statsByLocalPath.has(normalized.path)) {
				statsByLocalPath.set(normalized.path, normalized)
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

function toLocalPath(base: string, remotePath: string): string | undefined {
	const absolutePath = normalizeRemotePath(
		isAbsolute(remotePath) ? remotePath : join(base, remotePath),
	)
	if (absolutePath === base) {
		return ''
	}
	if (!isSub(base, absolutePath)) {
		return undefined
	}
	return absolutePath.slice(base === '/' ? 1 : base.length).replace(/^\/+/, '')
}

function toLocalStat(base: string, stat: StatModel): StatModel | undefined {
	const localPath = toLocalPath(base, stat.path)
	if (!localPath) {
		return undefined
	}
	return { ...stat, path: localPath }
}

function normalizeRemotePath(path: string): string {
	const normalized = normalize(path)
	return normalized.length > 1 && normalized.endsWith('/')
		? normalized.slice(0, -1)
		: normalized
}
