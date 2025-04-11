import { Vault } from 'obsidian'
import { useSettings } from '~/settings'
import { SyncRecord } from '~/storage/helper'
import GlobMatch from '~/utils/glob-match'
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
		const records = await this.options.syncRecord.getRecords()
		const filters = GlobMatch.from(settings?.filters ?? [], {
			flags: 'gi',
		})
		return traverseLocalVault(this.options.vault, filters)
	}
}
