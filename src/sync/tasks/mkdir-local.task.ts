import logger from '~/utils/logger'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import { BaseTask, toTaskError } from './task.interface'

export default class MkdirLocalTask extends BaseTask {
	async exec() {
		try {
			logger.info(`[MkdirLocal] ${this.localPath}`)
			await mkdirsVault(this.vault, this.localPath)
			return { success: true } as const
		} catch (e) {
			logger.error(`[MkdirLocal] failed: ${this.localPath}`, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
