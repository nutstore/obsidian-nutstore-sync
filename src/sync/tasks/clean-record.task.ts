import logger from '~/utils/logger'
import { BaseTask, BaseTaskOptions, toTaskError } from './task.interface'

export default class CleanRecordTask extends BaseTask {
	constructor(public readonly options: BaseTaskOptions) {
		super(options)
	}

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
