import i18n from '~/i18n'
import logger from '~/utils/logger'
import { statVaultItem } from '~/utils/stat-vault-item'
import { BaseTask, BaseTaskOptions, toTaskError } from './task.interface'

interface MkdirsRemoteTaskOptions extends BaseTaskOptions {
	// Additional paths that will be created along with the main path
	additionalPaths: Array<{ localPath: string; remotePath: string }>
}

/**
 * Task to create multiple directories in one operation.
 * Uses recursive: true so creating the deepest path will create all parents.
 * Stores all paths for sync record updates.
 */
export default class MkdirsRemoteTask extends BaseTask {
	readonly additionalPaths: Array<{ localPath: string; remotePath: string }>

	constructor(options: MkdirsRemoteTaskOptions) {
		super(options)
		this.additionalPaths = options.additionalPaths
	}

	async exec() {
		try {
			const localStat = await statVaultItem(this.vault, this.localPath)
			if (!localStat) {
				logger.debug('MkdirsRemoteTask: local path:', this.localPath)
				logger.debug('MkdirsRemoteTask: local stat is null')
				throw new Error(
					i18n.t('sync.error.localPathNotFound', { path: this.localPath }),
				)
			}
			// Create the deepest directory with recursive: true
			// This will automatically create all parent directories
			await this.webdav.createDirectory(this.remotePath, {
				recursive: true,
			})
			return { success: true }
		} catch (e) {
			logger.error(this, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}

	/**
	 * Get all directory paths that will be created by this task
	 */
	getAllPaths(): Array<{ localPath: string; remotePath: string }> {
		return [
			{ localPath: this.localPath, remotePath: this.remotePath },
			...this.additionalPaths,
		]
	}

	toJSON() {
		const base = super.toJSON()
		return {
			...base,
			additionalPaths: this.additionalPaths,
			totalDirs: this.getAllPaths().length,
		}
	}
}
