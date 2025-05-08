import { normalizePath, Vault } from 'obsidian'
import { useSettings } from '~/settings'
import { SyncRecord } from '~/storage/helper'
import GlobMatch, {
	isVoidGlobMatchOptions,
	needIncludeFromGlobRules,
} from '~/utils/glob-match'
import { traverseLocalVault } from '~/utils/traverse-local-vault'
import IFileSystem from './fs.interface'

export class LocalVaultFileSystem implements IFileSystem {
	constructor(
		private readonly options: {
			vault: Vault
			syncRecord: SyncRecord
		},
	) {}

	async walk() {
		const settings = await useSettings()
		const exclusions = (settings?.filterRules.exclusionRules ?? [])
			.filter((opt) => !isVoidGlobMatchOptions(opt))
			.map((opt) => new GlobMatch(opt))
		const inclusion = (settings?.filterRules.inclusionRules ?? [])
			.filter((opt) => !isVoidGlobMatchOptions(opt))
			.map((opt) => new GlobMatch(opt))
		const inclusionDirs = inclusion.map((d) => normalizePath(d.expr))
		return traverseLocalVault(this.options.vault, (path) => {
			let pathWithSuffix = path.endsWith('/') ? path : `${path}/`
			for (const dir of inclusionDirs) {
				if (dir.startsWith(pathWithSuffix)) {
					return true
				}
			}
			return needIncludeFromGlobRules(path, inclusion, exclusions)
		})
	}
}
