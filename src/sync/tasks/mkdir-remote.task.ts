import i18n from '~/i18n'
import logger from '~/utils/logger'
import { statVaultItem } from '~/utils/stat-vault-item'
import { BaseTask, toTaskError } from './task.interface'

export default class MkdirRemoteTask extends BaseTask {
	async exec() {
		try {
			const localStat = await statVaultItem(this.vault, this.localPath)
			if (!localStat) {
				logger.debug('PullTask: local path:', this.localPath)
				logger.debug('PullTask: local stat is null')
				throw new Error(
					i18n.t('sync.error.localPathNotFound', { path: this.localPath }),
				)
			}
			await this.webdav.createDirectory(this.remotePath, {
				recursive: true,
			})
			return { success: true }
		} catch (e) {
			logger.error(this, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
