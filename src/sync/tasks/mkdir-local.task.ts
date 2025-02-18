import consola from 'consola'
import { basename } from 'path'
import { StatModel } from '~/model/stat.model'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import { statWebDAVItem } from '~/utils/stat-webdav-item'
import { BaseTask } from './task.interface'

export default class MkdirLocalTask extends BaseTask {
	async exec() {
		try {
			await mkdirsVault(this.vault, this.localPath)
			const remoteStat = await statWebDAVItem(this.webdav, this.remotePath)
			const localStat: StatModel = {
				path: this.localPath,
				basename: basename(this.localPath),
				isDir: true,
				isDeleted: false,
				mtime: remoteStat.mtime,
			}
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
