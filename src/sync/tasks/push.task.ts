import consola from 'consola'
import { normalizePath } from 'obsidian'
import { dirname } from 'path'
import { mkdirsWedbDAV } from '~/utils/mkdirs-webdav'
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
			await mkdirsWedbDAV(this.webdav, dirname(this.remotePath))
			const content = await this.vault.adapter.readBinary(
				normalizePath(this.localPath),
			)
			const res = await this.webdav.putFileContents(this.remotePath, content, {
				overwrite: this.options.overwrite ?? false,
			})
			const remoteStat = await statWebDAVItem(this.webdav, this.remotePath)
			const localStat = await statVaultItem(this.vault, this.localPath)
			if (!localStat) {
				consola.debug('PushTask: local path:', this.localPath)
				consola.debug('PushTask: local stat is null')
				return false
			}
			this.syncRecord.updateFileRecord(this.localPath, {
				local: localStat,
				remote: remoteStat,
				base: new Blob([content]),
			})
			return res
		} catch (e) {
			consola.error(this, e)
			return false
		}
	}
}
