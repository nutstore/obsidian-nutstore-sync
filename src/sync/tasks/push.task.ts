import { normalizePath } from 'obsidian'
import { statVaultItem } from '~/utils/stat-vault-item'
import { statWebDAVItem } from '~/utils/stat-webdav-item'
import { BaseTask, BaseTaskOptions } from './task.interface'

export default class PushTask extends BaseTask {
	constructor(
		readonly options: BaseTaskOptions & {
			overwrite?: boolean
		},
	) {
		super(options)
	}

	async exec() {
		try {
			const content = await this.vault.adapter.readBinary(
				normalizePath(this.localPath),
			)
			const res = await this.webdav.putFileContents(this.remotePath, content, {
				overwrite: this.options.overwrite ?? false,
			})
			const remoteStat = await statWebDAVItem(this.webdav, this.remotePath)
			const localStat = await statVaultItem(this.vault, this.localPath)
			if (!localStat) {
				console.debug('PushTask: local path:', this.localPath)
				console.debug('PushTask: local stat is null')
				return false
			}
			this.syncRecord.updateFileRecord(this.localPath, {
				local: localStat,
				remote: remoteStat,
				base: new Blob([content]),
			})
			return res
		} catch (e) {
			console.error(this, e)
			return false
		}
	}
}
