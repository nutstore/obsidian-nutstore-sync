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
import logger from '~/utils/logger'
import { mergeDigIn } from '~/utils/merge-dig-in'
import { statVaultItem } from '~/utils/stat-vault-item'
import { statWebDAVItem } from '~/utils/stat-webdav-item'
import { resolveByIntelligentMerge } from '../core/merge-utils'
import { BaseTask, BaseTaskOptions, toTaskError } from './task.interface'

export enum ConflictStrategy {
	DiffMatchPatch = 'diff-match-patch',
	LatestTimeStamp = 'latest-timestamp',
	Skip = 'skip',
	DiffMatchPatchOrSkip = 'diff-match-patch-or-skip',
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
			useGitStyle: boolean
			mobileAppDownloadFileChunkSize?: string
		},
	) {
		super(options)
	}

	async exec() {
		try {
			logger.info(
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
				case ConflictStrategy.DiffMatchPatch:
					return await this.execIntelligentMerge()
				case ConflictStrategy.LatestTimeStamp:
					return await this.execLatestTimeStamp(local, remote)
				case ConflictStrategy.Skip:
					// Skip conflict resolution - keep files as they are
					// Don't update record to preserve conflict state for next sync
					return { success: true, skipRecord: true } as const
				case ConflictStrategy.DiffMatchPatchOrSkip:
					return await this.execIntelligentMergeOrSkip()
				case ConflictStrategy.LocalPriority:
					return await this.execLocalPriority()
				case ConflictStrategy.ServerPriority:
					return await this.execServerPriority(remote)
			}
		} catch (e) {
			logger.error(`[ConflictResolve] failed: ${this.localPath}`, e)
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
			if (remote.isDir) {
				throw new Error('Remote path is a directory: ' + this.remotePath)
			}
			const remoteSize = remote.size

			if (remoteMtime === localMtime) {
				return { success: true } as const
			}

			logger.info(
				`[ConflictResolve/LatestTimestamp] ${this.localPath}: ${remoteMtime > localMtime ? 'remote newer → pull' : 'local newer → push'}`,
			)

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
			if (remoteMtime > localMtime) {
				await downloadRemoteFile({
					vault: this.vault,
					webdav: this.webdav,
					remotePath: this.remotePath,
					localPath: this.localPath,
					remoteSize,
					mobileAppDownloadFileChunkSize:
						this.options.mobileAppDownloadFileChunkSize,
				})
			} else {
				const localContent = await readLocalBinary(this.vault, this.localPath)
				await this.webdav.putFileContents(this.remotePath, localContent, {
					overwrite: true,
				})
			}

			return { success: true } as const
		} catch (e) {
			logger.error(
				`[ConflictResolve/LatestTimestamp] failed: ${this.localPath}`,
				e,
			)
			return { success: false, error: toTaskError(e, this) }
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
			logger.error(
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
			logger.error(
				`[ConflictResolve/ServerPriority] failed: ${this.localPath}`,
				e,
			)
			return { success: false, error: toTaskError(e, this) }
		}
	}

	async execIntelligentMergeOrSkip() {
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
			const baseText = (await baseBlob?.text()) ?? localText

			const mergeResult = await resolveByIntelligentMerge({
				localContentText: localText,
				remoteContentText: remoteText,
				baseContentText: baseText,
			})

			logger.info(
				`[ConflictResolve/DiffMatchPatchOrSkip] ${this.localPath}: patch_apply ${mergeResult.success ? 'ok' : 'failed → skip'}`,
			)

			if (!mergeResult.success) {
				throw new Error(i18n.t('sync.error.failedToAutoMerge'))
			}

			if (mergeResult.isIdentical) {
				return { success: true } as const
			}

			const mergedText = mergeResult.mergedText!

			if (mergedText === remoteText) {
				if (mergedText !== localText) {
					await writeLocalText(this.vault, this.localPath, mergedText)
				}
				return { success: true } as const
			}

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
			logger.error(
				`[ConflictResolve/DiffMatchPatchOrSkip] failed: ${this.localPath}`,
				e,
			)
			return { success: false, error: toTaskError(e, this) }
		}
	}

	async execIntelligentMerge() {
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
			const baseText = (await baseBlob?.text()) ?? localText

			const mergeResult = await resolveByIntelligentMerge({
				localContentText: localText,
				remoteContentText: remoteText,
				baseContentText: baseText,
			})

			logger.info(
				`[ConflictResolve/DiffMatchPatch] ${this.localPath}: patch_apply ${mergeResult.success ? 'ok' : 'failed → fallback to mergeDigIn'}`,
			)

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
					await writeLocalText(this.vault, this.localPath, mergedDmpText)
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
			logger.error(
				`[ConflictResolve/DiffMatchPatch] failed: ${this.localPath}`,
				e,
			)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
