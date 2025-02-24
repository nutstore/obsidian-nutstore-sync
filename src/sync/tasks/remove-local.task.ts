import consola from 'consola'
import i18n from '~/i18n'
import { statVaultItem } from '~/utils/stat-vault-item'
import { BaseTask, BaseTaskOptions, toTaskError } from './task.interface'

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
				throw new Error(i18n.t('sync.error.notFound', { path: this.localPath }))
			}
			if (stat.isDir) {
				await this.vault.adapter.rmdir(
					this.localPath,
					this.options.recursive ?? false,
				)
			} else {
				await this.vault.adapter.remove(this.localPath)
			}
			return { success: true }
		} catch (e) {
			consola.error(e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
