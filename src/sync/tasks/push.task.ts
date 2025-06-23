import logger from '~/utils/logger'
import { BaseTask, BaseTaskOptions, toTaskError } from './task.interface'

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
			const file = this.vault.getFileByPath(this.localPath)
			if (!file) {
				throw new Error('cannot find file in local fs: ' + this.localPath)
			}

			const content = await this.vault.readBinary(file)
			const res = await this.webdav.putFileContents(this.remotePath, content, {
				overwrite: this.options.overwrite ?? false,
			})
			return { success: res }
		} catch (e) {
			logger.error(this, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
