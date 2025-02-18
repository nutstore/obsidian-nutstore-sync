import consola from 'consola'
import { statVaultItem } from '~/utils/stat-vault-item'
import { BaseTask, BaseTaskOptions } from './task.interface'

export default class RemoveLocalTask extends BaseTask {
	constructor(
		public readonly options: BaseTaskOptions & {
			recursive?: boolean
		},
	) {
		super(options)
	}

	async exec() {
		try {
			const stat = await statVaultItem(this.vault, this.localPath)
			if (!stat) {
				throw new Error('not found: ' + this.localPath)
			}
			if (stat.isDir) {
				await this.vault.adapter.rmdir(
					this.localPath,
					this.options.recursive ?? false,
				)
			} else {
				await this.vault.adapter.remove(this.localPath)
			}
			return true
		} catch (e) {
			consola.error(e)
			return false
		}
	}
}
