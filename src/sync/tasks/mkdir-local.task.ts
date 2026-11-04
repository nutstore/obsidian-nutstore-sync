import { mkdirsVault } from '~/utils/mkdirs-vault'
import { BaseTask, toTaskError, type ScopeTarget } from './task.interface'

export default class MkdirLocalTask extends BaseTask {
	override get scopeTargets(): ScopeTarget[] {
		return [{ path: this.localPath, subtree: false, isDir: true }]
	}

	async exec() {
		try {
			this.logger.info(`[MkdirLocal] ${this.localPath}`)
			await mkdirsVault(this.vault, this.localPath)
			return { success: true } as const
		} catch (e) {
			this.logger.error(`[MkdirLocal] failed: ${this.localPath}`, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
