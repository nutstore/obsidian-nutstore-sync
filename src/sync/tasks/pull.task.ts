import { dirname } from 'path'
import { BufferLike } from 'webdav'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import { statVaultItem } from '~/utils/stat-vault-item'
import { statWebDAVItem } from '~/utils/stat-webdav-item'
import { BaseTask } from './task.interface'

export default class PullTask extends BaseTask {
	async exec() {
		const lock = await this.webdav.lock(this.remotePath)
		try {
			await mkdirsVault(this.vault, dirname(this.localPath))
			const remoteStat = await statWebDAVItem(this.webdav, this.remotePath)
			const file = (await this.webdav.getFileContents(this.remotePath, {
				format: 'binary',
				details: false,
			})) as BufferLike
			await this.vault.adapter.writeBinary(this.localPath, file)
			const localStat = await statVaultItem(this.vault, this.localPath)
			if (!localStat) {
				console.debug('PullTask: local path:', this.localPath)
				console.debug('PullTask: local stat is null')
				return false
			}
			await this.syncRecord.updateFileRecord(this.localPath, {
				remote: remoteStat,
				local: localStat!,
				base: new Blob([file]),
			})
			return true
		} catch (e) {
			console.error(this, e)
			return false
		} finally {
			this.webdav.unlock(this.remotePath, lock.token)
		}
	}
}
