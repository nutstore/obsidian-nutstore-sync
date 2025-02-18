import consola from 'consola'
import { statVaultItem } from '~/utils/stat-vault-item'
import { statWebDAVItem } from '~/utils/stat-webdav-item'
import { BaseTask } from './task.interface'

export default class MkdirRemoteTask extends BaseTask {
	async exec() {
		try {
			const localStat = await statVaultItem(this.vault, this.localPath)
			if (!localStat) {
				consola.debug('PullTask: local path:', this.localPath)
				consola.debug('PullTask: local stat is null')
				return false
			}
			if (await this.webdav.exists(this.remotePath)) {
				consola.debug('mkdir remote: already exists:', this.remotePath)
				return true
			}
			await this.webdav.createDirectory(this.remotePath, {
				recursive: true,
			})
			const remoteStat = await statWebDAVItem(this.webdav, this.remotePath)
			await this.syncRecord.updateFileRecord(this.localPath, {
				local: localStat,
				remote: remoteStat,
			})
			return true
		} catch (e) {
			consola.error(this, e)
			return false
		}
	}
}
