import { Vault } from 'obsidian'
import { traverseLocalVault } from '~/utils/traverse-local-vault'
import IFileSystem from './fs.interface'

export class LocalVaultFileSystem implements IFileSystem {
	constructor(
		public readonly options: {
			vault: Vault
		},
	) {}

	async walk() {
		return traverseLocalVault(this.options.vault)
	}
}
