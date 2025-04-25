import { Vault } from 'obsidian'
import { useSettings } from '~/settings'
import { SyncRecord } from '~/storage/helper'
import GlobMatch, { isVoidGlobMatchOptions } from '~/utils/glob-match'
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
		const settings = useSettings()
		const filters = (settings?.filters ?? [])
			.filter((opt) => !isVoidGlobMatchOptions(opt))
			.map((opt) => new GlobMatch(opt))
		return traverseLocalVault(this.options.vault, filters)
	}
}
