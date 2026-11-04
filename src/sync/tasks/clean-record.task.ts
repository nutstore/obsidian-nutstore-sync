import { BaseTask, toTaskError, type ScopeTarget } from './task.interface'

export default class CleanRecordTask extends BaseTask {
	/** Touches only the record or nothing at all, never the subtree. */
	override get scopeTargets(): ScopeTarget[] {
		return [{ path: this.localPath, subtree: false, isDir: false }]
	}

	async exec() {
		try {
			const syncRecord = this.syncRecord
			await syncRecord.deleteFileRecord(this.localPath)

			return { success: true, skipRecord: true } as const
		} catch (e) {
			this.logger.error(this, e)
			return {
				success: false,
				error: toTaskError(e, this),
			}
		}
	}
}
