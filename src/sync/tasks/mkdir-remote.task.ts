import i18n from '~/i18n'
import { statVaultItem } from '~/utils/stat-vault-item'
import { BaseTask, toTaskError } from './task.interface'

export default class MkdirRemoteTask extends BaseTask {
	async exec() {
		try {
			const localStat = await statVaultItem(this.vault, this.localPath)
			if (!localStat) {
				this.logger.debug('[MkdirRemote] local path not found:', this.localPath)
				throw new Error(
					i18n.t('sync.error.localPathNotFound', { path: this.localPath }),
				)
			}
			this.logger.info(`[MkdirRemote] ${this.remotePath}`)
			await this.webdav.createDirectory(this.remotePath, {
				recursive: true,
			})
			return { success: true } as const
		} catch (e) {
			this.logger.error(`[MkdirRemote] failed: ${this.remotePath}`, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
