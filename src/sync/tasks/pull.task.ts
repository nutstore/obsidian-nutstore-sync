import consola from 'consola'
import { dirname } from 'path'
import { BufferLike } from 'webdav'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import { BaseTask, toTaskError } from './task.interface'

export default class PullTask extends BaseTask {
	async exec() {
		try {
			await mkdirsVault(this.vault, dirname(this.localPath))
			const file = (await this.webdav.getFileContents(this.remotePath, {
				format: 'binary',
				details: false,
			})) as BufferLike
			await this.vault.adapter.writeBinary(this.localPath, file)
			return { success: true }
		} catch (e) {
			consola.error(this, e)
			return { success: false, error: toTaskError(e) }
		}
	}
}
