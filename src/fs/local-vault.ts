import { Vault } from 'obsidian'
import { useSettings } from '~/settings'
import { SyncRecord } from '~/storage/helper'
import GlobMatch, {
	extendRules,
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
		const exclusions = extendRules(
			(settings?.filterRules.exclusionRules ?? [])
				.filter((opt) => !isVoidGlobMatchOptions(opt))
				.map(({ expr, options }) => new GlobMatch(expr, options)),
		)
		const inclusion = extendRules(
			(settings?.filterRules.inclusionRules ?? [])
				.filter((opt) => !isVoidGlobMatchOptions(opt))
				.map(({ expr, options }) => new GlobMatch(expr, options)),
		)
		const stats = await traverseLocalVault(
			this.options.vault,
			this.options.vault.getRoot().path,
		)
		const filteredStats = stats.filter((s) =>
			needIncludeFromGlobRules(s.path, inclusion, exclusions),
		)
		return completeLossDir(stats, filteredStats)
	}
}
