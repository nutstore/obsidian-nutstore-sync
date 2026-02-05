import { Vault } from 'obsidian'
import { useSettings } from '~/settings'
import { SyncRecord } from '~/storage/sync-record'
import GlobMatch, {
	GlobMatchOptions,
	isVoidGlobMatchOptions,
	needIncludeFromGlobRules,
} from '~/utils/glob-match'
import { traverseLocalVault } from '~/utils/traverse-local-vault'
import AbstractFileSystem from './fs.interface'
import completeLossDir from './utils/complete-loss-dir'

export class LocalVaultFileSystem implements AbstractFileSystem {
	constructor(
		private readonly options: {
			vault: Vault
			syncRecord: SyncRecord
		},
	) {}

	async walk() {
		const settings = await useSettings()
		const exclusions = this.buildRules(settings?.filterRules.exclusionRules)
		const inclusions = this.buildRules(settings?.filterRules.inclusionRules)

		const stats = await traverseLocalVault(
			this.options.vault,
			this.options.vault.getRoot().path,
		)
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
		return rules
			.filter((opt) => !isVoidGlobMatchOptions(opt))
			.map(({ expr, options }) => new GlobMatch(expr, options))
	}
}
