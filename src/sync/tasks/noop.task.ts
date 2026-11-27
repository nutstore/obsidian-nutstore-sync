import type { StatModel } from '~/model/stat.model'
import { BaseTask, BaseTaskOptions, type ScopeTarget } from './task.interface'

export interface NoopTaskOptions extends BaseTaskOptions {
	localStat?: StatModel
	remoteStat?: StatModel
}

export default class NoopTask extends BaseTask {
	constructor(readonly options: NoopTaskOptions) {
		super(options)
	}

	/** Touches only the record or nothing at all, never the subtree. */
	override get scopeTargets(): ScopeTarget[] {
		return [{ path: this.localPath, subtree: false, isDir: false }]
	}

	exec() {
		const { localStat, remoteStat } = this.options
		if (localStat && remoteStat) {
			if (!remoteStat.isDir && !remoteStat.etag) {
				return {
					success: true,
					receipt: { kind: 'unverified' },
				} as const
			}
			return {
				success: true,
				receipt: {
					kind: 'synced',
					local: localStat,
					remote: { ...remoteStat, path: this.localPath },
				},
			} as const
		}
		return {
			success: true,
		} as const
	}
}
