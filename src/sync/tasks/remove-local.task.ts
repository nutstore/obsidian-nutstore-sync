import type { FileManager } from 'obsidian'
import { removeLocalPath } from '~/utils/local-vault-io'
import { statVaultItem } from '~/utils/stat-vault-item'
import { BaseTask, BaseTaskOptions, toTaskError } from './task.interface'

export default class RemoveLocalTask extends BaseTask {
	constructor(
		public readonly options: BaseTaskOptions & {
			fileManager: FileManager
			recursive?: boolean
		},
	) {
		super(options)
	}

	async exec() {
		try {
			const stat = await statVaultItem(this.vault, this.localPath)
			if (!stat) {
				return {
					success: true,
				} as const
			}
			this.logger.info(`[RemoveLocal] ${this.localPath}`)
			await removeLocalPath(
				this.options,
				this.localPath,
				this.options.recursive,
			)
			return { success: true } as const
		} catch (e) {
			this.logger.error(`[RemoveLocal] failed: ${this.localPath}`, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
