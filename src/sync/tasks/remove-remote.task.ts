import { BaseTask, toTaskError } from './task.interface'

/**
 * Deletes a remote path. Nutstore silently ignores `If-Match` and
 * `If-Unmodified-Since` on `DELETE` (see contract in `src/api/webdav.ts`), so
 * remote-change protection is enforced at decision time and via
 * `failedMoveSources` in `src/sync/index.ts`.
 */
export default class RemoveRemoteTask extends BaseTask {
	async exec() {
		try {
			this.logger.info(`[RemoveRemote] ${this.remotePath}`)
			await this.webdav.deleteFile(this.remotePath)
			return {
				success: true,
				receipt: { kind: 'deleted' },
			} as const
		} catch (e) {
			this.logger.error(`[RemoveRemote] failed: ${this.remotePath}`, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
