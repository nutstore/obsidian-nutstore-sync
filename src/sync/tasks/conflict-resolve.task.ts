import { isEqual, noop } from 'lodash-es'
import { BufferLike } from 'webdav'
import i18n from '~/i18n'
import { StatModel } from '~/model/stat.model'
import { SyncRecordModel } from '~/model/sync-record.model'
import { blobStore } from '~/storage/blob'
import { isMergeablePath } from '~/sync/utils/is-mergeable-path'
import logger from '~/utils/logger'
import { mergeDigIn } from '~/utils/merge-dig-in'
import { statVaultItem } from '~/utils/stat-vault-item'
import { statWebDAVItem } from '~/utils/stat-webdav-item'
import {
	LatestTimestampResolution,
	resolveByIntelligentMerge,
	resolveByLatestTimestamp,
} from '../core/merge-utils'
import { BaseTask, BaseTaskOptions, toTaskError } from './task.interface'

export enum ConflictStrategy {
	DiffMatchPatch = 'diff-match-patch',
	LatestTimeStamp = 'latest-timestamp',
	Skip = 'skip',
}

export default class ConflictResolveTask extends BaseTask {
	constructor(
		public readonly options: BaseTaskOptions & {
			record?: SyncRecordModel
			strategy: ConflictStrategy
			remoteStat?: StatModel
			localStat?: StatModel
			useGitStyle: boolean
		},
	) {
		super(options)
	}

	async exec() {
		try {
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
				case ConflictStrategy.DiffMatchPatch:
					return await this.execIntelligentMerge()
				case ConflictStrategy.LatestTimeStamp:
					return await this.execLatestTimeStamp(local, remote)
				case ConflictStrategy.Skip:
					// Skip conflict resolution - keep files as they are
					// Don't update record to preserve conflict state for next sync
					return { success: true, skipRecord: true } as const
			}
		} catch (e) {
			logger.error(this, e)
			return {
				success: false,
				error: toTaskError(e, this),
			}
		}
	}

	async execLatestTimeStamp(local: StatModel, remote: StatModel) {
		try {
			// At this point we know both local and remote are files (not directories)
			// so mtime is guaranteed to exist
			const localMtime = local.mtime!
			const remoteMtime = remote.mtime!

			if (remoteMtime === localMtime) {
				return { success: true } as const
			}

			const file = this.vault.getFileByPath(this.localPath)
			if (!file) {
				return {
					success: false,
					error: toTaskError(
						new Error('cannot find file in local fs: ' + this.localPath),
						this,
					),
				}
			}
			const localContent = await this.vault.readBinary(file)
			const remoteContent = (await this.webdav.getFileContents(
				this.remotePath,
				{
					details: false,
					format: 'binary',
				},
			)) as BufferLike

			const result = resolveByLatestTimestamp({
				localMtime,
				remoteMtime,
				localContent,
				remoteContent,
			})

			switch (result.status) {
				case LatestTimestampResolution.UseRemote:
					const arrayBuffer =
						result.content instanceof ArrayBuffer
							? result.content
							: new Uint8Array(result.content).buffer
					await this.vault.modifyBinary(file, arrayBuffer)
					break
				case LatestTimestampResolution.UseLocal:
					await this.webdav.putFileContents(this.remotePath, result.content, {
						overwrite: true,
					})
					break
				case LatestTimestampResolution.NoChange:
					noop()
					break
			}

			return { success: true } as const
		} catch (e) {
			logger.error(this, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}

	async execIntelligentMerge() {
		try {
			const file = this.vault.getFileByPath(this.localPath)
			if (!file) {
				throw new Error('cannot find file in local fs: ' + this.localPath)
			}
			const localBuffer = await this.vault.readBinary(file)
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

			const localIsMergeable = isMergeablePath(file.path)
			const remoteIsMergeable = isMergeablePath(this.remotePath)

			if (!(localIsMergeable && remoteIsMergeable)) {
				throw new Error(i18n.t('sync.error.cannotMergeBinary'))
			}

			const localText = await new Blob([new Uint8Array(localBuffer)]).text()
			const remoteText = await new Blob([new Uint8Array(remoteBuffer)]).text()
			const baseText = (await baseBlob?.text()) ?? localText

			const mergeResult = await resolveByIntelligentMerge({
				localContentText: localText,
				remoteContentText: remoteText,
				baseContentText: baseText,
			})

			if (!mergeResult.success) {
				// If patch_apply fails to resolve all, use mergeDigIn as a further fallback
				const mergeDigInResult = mergeDigIn(localText, baseText, remoteText, {
					stringSeparator: '\n',
					useGitStyle: this.options.useGitStyle,
				})
				// mergeDigIn itself might produce conflict markers if it can't fully resolve.
				// The task should handle this merged text (which might contain markers).
				const mergedDmpText = mergeDigInResult.result.join('\n')

				const putResult = await this.webdav.putFileContents(
					this.remotePath,
					mergedDmpText,
					{ overwrite: true },
				)

				if (putResult) {
					await this.vault.modify(file, mergedDmpText)
					return { success: true } as const
				} else {
					throw new Error(i18n.t('sync.error.failedToUploadMerged'))
				}
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
					await this.vault.modify(file, mergedText)
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
				await this.vault.modify(file, mergedText)
			}

			return { success: true } as const
		} catch (e) {
			logger.error(this, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
