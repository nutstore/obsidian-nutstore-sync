import { Vault } from 'obsidian'
import { SyncScope } from '~/sync/scope'
import type { NutstoreSettings } from '~/settings'
import { SyncRecord } from '~/storage/sync-record'
import {
	ConfigDirSyncMode,
	computeEffectiveFilterRulesFromParts,
} from '~/utils/config-dir-rules'
import {
	compileFilterRules,
	GlobFilterRule,
	isPathIncluded,
} from '~/utils/glob-match'
import { traverseLocalVault } from '~/utils/traverse-local-vault'
import { isSyncCacheLocalPath } from '~/utils/sync-cache-file'
import AbstractFileSystem from './fs.interface'
import completeLossDir from './utils/complete-loss-dir'

export class LocalVaultFileSystem implements AbstractFileSystem {
	scope = new SyncScope()
	constructor(
		private readonly options: {
			vault: Vault
			syncRecord: SyncRecord
			filterRules?: {
				rules: GlobFilterRule[]
				configDir?: string
				configDirSyncMode?: ConfigDirSyncMode
			}
			settings?: NutstoreSettings
		},
	) {}

	async walk() {
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
		const compiledRules = compileFilterRules(filterRules?.rules)

		this.scope = new SyncScope(filterRules?.rules)
		const snapshot = await traverseLocalVault(
			this.options.vault,
			this.options.vault.getRoot().path,
			this.scope,
		)
		const stats = snapshot.entries
		const includedStats = stats.filter(
			(stat) =>
				!isSyncCacheLocalPath(stat.path, this.options.vault.configDir) &&
				isPathIncluded(stat.path, compiledRules, stat.isDir),
		)
		const completeStats = completeLossDir(stats, includedStats)
		const completeStatPaths = new Set(completeStats.map((s) => s.path))
		return stats.map((stat) => ({
			stat,
			ignored: !completeStatPaths.has(stat.path),
		}))
	}
}
