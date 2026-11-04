import { BaseTask, type ScopeTarget } from './task.interface'

export default class NoopTask extends BaseTask {
	/** Touches only the record or nothing at all, never the subtree. */
	override get scopeTargets(): ScopeTarget[] {
		return [{ path: this.localPath, subtree: false, isDir: false }]
	}

	exec() {
		return {
			success: true,
		} as const
	}
}
