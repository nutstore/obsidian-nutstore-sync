import logger from '~/utils/logger'
import { existsLocalPath, readLocalBinary } from '~/utils/local-vault-io'
import { BaseTask, toTaskError } from './task.interface'

export default class PushTask extends BaseTask {
	async exec() {
		try {
			const exists = await existsLocalPath(this.vault, this.localPath)
			if (!exists) {
				throw new Error('cannot find file in local fs: ' + this.localPath)
			}

			const content = await readLocalBinary(this.vault, this.localPath)
			logger.info(
				`[PushTask] ${this.localPath} → ${this.remotePath} (${content.byteLength} bytes)`,
			)
			const res = await this.webdav.putFileContents(this.remotePath, content, {
				overwrite: true,
			})
			if (!res) {
				throw new Error('Upload failed')
			}
			return { success: res }
		} catch (e) {
			logger.error(`[PushTask] failed: ${this.localPath}`, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
