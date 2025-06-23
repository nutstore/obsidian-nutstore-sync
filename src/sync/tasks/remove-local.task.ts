import i18n from '~/i18n'
import logger from '~/utils/logger'
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
			const file = this.vault.getFileByPath(this.localPath)
			if (!file) {
				throw new Error('cannot find file in local fs: ' + this.localPath)
			}
			await this.vault.trash(file, false)
			return { success: true }
		} catch (e) {
			logger.error(e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
