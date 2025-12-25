import logger from '~/utils/logger'
import { BaseTask, toTaskError } from './task.interface'

export default class CleanRecordTask extends BaseTask {
	async exec() {
		try {
			const syncRecord = this.syncRecord
			await syncRecord.deleteFileRecord(this.localPath)

			return { success: true }
		} catch (e) {
			logger.error(this, e)
			return {
				success: false,
				error: toTaskError(e, this),
			}
		}
	}
}
