import { statVaultItem } from '~/utils/stat-vault-item'
import { statWebDAVItem } from '~/utils/stat-webdav-item'
import { BaseTask } from './task.interface'

export default class UpdateSyncRecordTask extends BaseTask {
	async exec() {
		try {
			const local = await statVaultItem(this.vault, this.localPath)
			if (!local) {
				throw new Error(
					'UpdateSyncRecordTask: local stat is nil: ' + this.localPath,
				)
			}
			const remote = await statWebDAVItem(this.webdav, this.remotePath)
			const file = await this.vault.adapter.readBinary(this.localPath)
			await this.syncRecord.updateFileRecord(this.localPath, {
				local,
				remote,
				base: new Blob([file]),
			})
			return true
		} catch (e) {
			console.error(this, e)
			return false
		}
	}
}
