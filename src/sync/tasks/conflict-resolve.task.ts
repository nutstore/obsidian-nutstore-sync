import { isEqual } from 'lodash-es'
import { BufferLike } from 'webdav'
import i18n from '~/i18n'
import { StatModel } from '~/model/stat.model'
import { SyncRecordModel } from '~/model/sync-record.model'
import { blobStore } from '~/storage/blob'
import { isMergeablePath } from '~/sync/utils/is-mergeable-path'
import { downloadRemoteFile } from '~/utils/chunked-download'
import {
	existsLocalPath,
	readLocalBinary,
	writeLocalText,
} from '~/utils/local-vault-io'
import { statVaultItem } from '~/utils/stat-vault-item'
import { statWebDAVItem } from '~/utils/stat-webdav-item'
import {
	IntelligentMergeParams,
	IntelligentMergeResult,
	resolveByDiff3Merge,
	resolveByIntelligentMerge,
} from '../core/merge-utils'
import { BaseTask, BaseTaskOptions, toTaskError } from './task.interface'

export enum ConflictStrategy {
	NoConflictMerge = 'no-conflict-merge',
	Diff3 = 'diff3',
	LocalPriority = 'local-priority',
	ServerPriority = 'server-priority',
}

export default class ConflictResolveTask extends BaseTask {
	constructor(
		public readonly options: BaseTaskOptions & {
			record?: SyncRecordModel
			strategy: ConflictStrategy
			remoteStat?: StatModel
			localStat?: StatModel
			mobileAppDownloadFileChunkSize?: string
		},
	) {
		super(options)
	}

	async exec() {
		try {
			this.logger.info(
				`[ConflictResolve] ${this.localPath} strategy=${this.options.strategy}`,
			)

			const local =
				this.options.localStat ??
				(await statVaultItem(this.vault, this.localPath))

			if (!local) {
				throw new Error('Local file not found: ' + this.localPath)
			}

			const remote =
				this.options.remoteStat ??
				(await statWebDAVItem(this.webdav, this.remotePath))

			if (remote.isDir) {
				throw new Error('Remote path is a directory: ' + this.remotePath)
			}

			if (local.isDir) {
				throw new Error('Local path is a directory: ' + this.localPath)
			}

			if (local.size === 0 && remote.size === 0) {
				return { success: true } as const
			}

			switch (this.options.strategy) {
				case ConflictStrategy.NoConflictMerge:
					return await this.execMerge(
						resolveByIntelligentMerge,
						'NoConflictMerge',
					)
				case ConflictStrategy.Diff3:
					return await this.execMerge(resolveByDiff3Merge, 'Diff3')
				case ConflictStrategy.LocalPriority:
					return await this.execLocalPriority()
				case ConflictStrategy.ServerPriority:
					return await this.execServerPriority(remote)
			}
		} catch (e) {
			this.logger.error(`[ConflictResolve] failed: ${this.localPath}`, e)
			return {
				success: false,
				error: toTaskError(e, this),
			}
		}
	}

	async execLocalPriority() {
		try {
			const exists = await existsLocalPath(this.vault, this.localPath)
			if (!exists) {
				return {
					success: false,
					error: toTaskError(
						new Error('cannot find file in local fs: ' + this.localPath),
						this,
					),
				}
			}
			const localContent = await readLocalBinary(this.vault, this.localPath)
			await this.webdav.putFileContents(this.remotePath, localContent, {
				overwrite: true,
			})
			return { success: true } as const
		} catch (e) {
			this.logger.error(
				`[ConflictResolve/LocalPriority] failed: ${this.localPath}`,
				e,
			)
			return { success: false, error: toTaskError(e, this) }
		}
	}

	async execServerPriority(remote: StatModel) {
		try {
			if (remote.isDir) {
				throw new Error('Remote path is a directory: ' + this.remotePath)
			}
			await downloadRemoteFile({
				vault: this.vault,
				webdav: this.webdav,
				remotePath: this.remotePath,
				localPath: this.localPath,
				remoteSize: remote.size,
				mobileAppDownloadFileChunkSize:
					this.options.mobileAppDownloadFileChunkSize,
			})
			return { success: true } as const
		} catch (e) {
			this.logger.error(
				`[ConflictResolve/ServerPriority] failed: ${this.localPath}`,
				e,
			)
			return { success: false, error: toTaskError(e, this) }
		}
	}

	async execMerge(
		resolver: (
			params: IntelligentMergeParams,
		) => IntelligentMergeResult | Promise<IntelligentMergeResult>,
		strategyName: string,
	) {
		try {
			const exists = await existsLocalPath(this.vault, this.localPath)
			if (!exists) {
				throw new Error('cannot find file in local fs: ' + this.localPath)
			}
			const localBuffer = await readLocalBinary(this.vault, this.localPath)
			const remoteBuffer = (await this.webdav.getFileContents(this.remotePath, {
				format: 'binary',
				details: false,
			})) as BufferLike

			if (isEqual(localBuffer, remoteBuffer)) {
				return { success: true } as const
			}

			const { record } = this.options
			let baseBlob: Blob | null = null
			const baseKey = record?.base?.key
			if (baseKey) {
				baseBlob = await blobStore.get(baseKey)
			}

			const localIsMergeable = isMergeablePath(this.localPath)
			const remoteIsMergeable = isMergeablePath(this.remotePath)

			if (!(localIsMergeable && remoteIsMergeable)) {
				throw new Error(i18n.t('sync.error.mergeNotSupported'))
			}

			const localText = await new Blob([new Uint8Array(localBuffer)]).text()
			const remoteText = await new Blob([new Uint8Array(remoteBuffer)]).text()
			const baseText = (await baseBlob?.text()) ?? ''

			const mergeResult = await resolver({
				localContentText: localText,
				remoteContentText: remoteText,
				baseContentText: baseText,
				filePath: this.localPath,
				hasBase: baseBlob !== null,
			})

			this.logger.info(
				`[ConflictResolve/${strategyName}] ${this.localPath}: merge ${mergeResult.success ? 'ok' : 'failed'}`,
			)

			if (!mergeResult.success) {
				throw new Error(i18n.t('sync.error.failedToAutoMerge'))
			}

			if (mergeResult.isIdentical) {
				// This case should be caught by the isEqual(localBuffer, remoteBuffer) check earlier,
				// but resolveByIntelligentMerge also returns it.
				return { success: true } as const
			}

			const mergedText = mergeResult.mergedText!

			// If mergedText is the same as remoteText, we only need to update localText if it's different.
			if (mergedText === remoteText) {
				if (mergedText !== localText) {
					await writeLocalText(this.vault, this.localPath, mergedText)
				}
				return { success: true } as const
			}

			// If mergedText is different from remoteText, then both remote and local need to be updated.
			const putResult = await this.webdav.putFileContents(
				this.remotePath,
				mergedText,
				{ overwrite: true },
			)

			if (!putResult) {
				throw new Error(i18n.t('sync.error.failedToUploadMerged'))
			}

			if (localText !== mergedText) {
				await writeLocalText(this.vault, this.localPath, mergedText)
			}

			return { success: true } as const
		} catch (e) {
			this.logger.error(
				`[ConflictResolve/${strategyName}] failed: ${this.localPath}`,
				e,
			)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
