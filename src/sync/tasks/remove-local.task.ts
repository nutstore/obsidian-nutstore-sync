import logger from '~/utils/logger'
import { removeLocalPath } from '~/utils/local-vault-io'
import { statVaultItem } from '~/utils/stat-vault-item'
import { BaseTask, BaseTaskOptions, toTaskError } from './task.interface'

export default class RemoveLocalTask extends BaseTask {
	constructor(
		public readonly options: BaseTaskOptions & {
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
			await removeLocalPath(this.vault, this.localPath, this.options.recursive)
			return { success: true } as const
		} catch (e) {
			logger.error(e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
