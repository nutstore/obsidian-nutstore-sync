import {
	BaseTask,
	type BaseTaskOptions,
	toTaskError,
	type ScopeTarget,
} from './task.interface'

export interface CleanRecordTaskOptions extends BaseTaskOptions {
	additionalPaths?: string[]
}

export default class CleanRecordTask extends BaseTask {
	readonly additionalPaths: string[]

	constructor(options: CleanRecordTaskOptions) {
		super(options)
		this.additionalPaths = options.additionalPaths ?? []
	}

	getAllPaths(): string[] {
		return [this.localPath, ...this.additionalPaths]
	}

	/** Touches only the recorded entries or nothing at all, never their subtrees. */
	override get scopeTargets(): ScopeTarget[] {
		return this.getAllPaths().map((path) => ({
			path,
			subtree: false,
			isDir: false,
		}))
	}

	async exec() {
		try {
			await this.syncRecord.batchDelete(this.getAllPaths())

			return { success: true, skipRecord: true } as const
		} catch (e) {
			this.logger.error(this, e)
			return {
				success: false,
				error: toTaskError(e, this),
			}
		}
	}

	override toJSON() {
		const base = super.toJSON()
		if (this.additionalPaths.length === 0) return base
		return {
			...base,
			additionalPaths: this.additionalPaths,
			totalPaths: this.additionalPaths.length + 1,
		}
	}
}
