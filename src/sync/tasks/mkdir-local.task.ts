import { basename, dirname } from 'path'
import { StatModel } from '~/model/stat.model'
import { statWebDAVItem } from '~/utils/stat-webdav-item'
import { BaseTask } from './task.interface'

export default class MkdirLocalTask extends BaseTask {
	async exec() {
		try {
			const stack: string[] = []
			let currentPath = this.localPath
			if (await this.vault.adapter.exists(currentPath)) {
				console.debug('mkdir: already exists: ', currentPath)
				return true
			}
			while (true) {
				if (await this.vault.adapter.exists(currentPath)) {
					break
				}
				stack.push(currentPath)
				currentPath = dirname(currentPath)
			}
			while (stack.length) {
				await this.vault.adapter.mkdir(stack.pop()!)
			}
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
			console.error(this, e)
			return false
		}
	}
}
