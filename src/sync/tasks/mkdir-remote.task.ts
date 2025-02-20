import consola from 'consola'
import i18n from '~/i18n'
import { statVaultItem } from '~/utils/stat-vault-item'
import { BaseTask, toTaskError } from './task.interface'

export default class MkdirRemoteTask extends BaseTask {
	async exec() {
		try {
			const localStat = await statVaultItem(this.vault, this.localPath)
			if (!localStat) {
				consola.debug('PullTask: local path:', this.localPath)
				consola.debug('PullTask: local stat is null')
				return {
					success: false,
					error: new Error(
						i18n.t('sync.error.localPathNotFound', { path: this.localPath }),
					),
				}
			}
			if (await this.webdav.exists(this.remotePath)) {
				consola.debug('mkdir remote: already exists:', this.remotePath)
				return { success: true }
			}
			await this.webdav.createDirectory(this.remotePath, {
				recursive: true,
			})
			return { success: true }
		} catch (e) {
			consola.error(this, e)
			return { success: false, error: toTaskError(e) }
		}
	}
}
