import { Vault } from 'obsidian'
import { SyncRecord } from '~/storage/helper'
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
		const records = await this.options.syncRecord.getRecords()
		return traverseLocalVault(this.options.vault, records)
	}
}
