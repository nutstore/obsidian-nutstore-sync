import { Buffer } from 'buffer'
import consola from 'consola'
import { diff_match_patch } from 'diff-match-patch'
import { isEqual } from 'lodash-es'
import { moment } from 'obsidian'
import { BufferLike } from 'webdav'
import i18n from '~/i18n'
import { StatModel } from '~/model/stat.model'
import { SyncRecordModel } from '~/model/sync-record.model'
import { isBinaryFile } from '~/utils/is-binary-file'
import { mergeDigIn } from '~/utils/merg-dig-in'
import { statVaultItem } from '~/utils/stat-vault-item'
import { statWebDAVItem } from '~/utils/stat-webdav-item'
import { BaseTask, BaseTaskOptions, toTaskError } from './task.interface'

export enum ConflictStrategy {
	DiffMatchPatch,
	LatestTimeStamp,
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
			if (local.size === 0 && remote.size === 0) {
				return { success: true }
			}
			switch (this.options.strategy) {
				case ConflictStrategy.DiffMatchPatch:
					return await this.execDiffMatchPatch()
				case ConflictStrategy.LatestTimeStamp:
					return await this.execLatestTimeStamp(local, remote)
			}
		} catch (e) {
			consola.error(this, e)
			return {
				success: false,
				error: toTaskError(e, this),
			}
		}
	}

	async execLatestTimeStamp(local: StatModel, remote: StatModel) {
		try {
			const localMtime = moment(local.mtime)
			const remoteMtime = moment(remote.mtime)
			if (remoteMtime.isSame(localMtime)) {
				throw new Error()
			}
			const localContent = await this.vault.adapter.readBinary(this.localPath)
			const useRemote = remoteMtime.isAfter(localMtime)
			if (useRemote) {
				const remoteContent = (await this.webdav.getFileContents(
					this.remotePath,
					{
						details: false,
						format: 'binary',
					},
				)) as BufferLike
				if (isEqual(localContent, remoteContent)) {
					await this.vault.adapter.writeBinary(this.localPath, remoteContent)
				}
			} else {
				await this.webdav.putFileContents(this.remotePath, localContent, {
					overwrite: true,
				})
			}
			return { success: true }
		} catch (e) {
			consola.error(e)
			return { success: false, error: toTaskError(e, this) }
		}
	}

	async execDiffMatchPatch() {
		try {
			const localBuffer = await this.vault.adapter.readBinary(this.localPath)
			const remoteBuffer = (await this.webdav.getFileContents(this.remotePath, {
				format: 'binary',
				details: false,
			})) as BufferLike
			if (await isEqual(localBuffer, remoteBuffer)) {
				return { success: true }
			}
			if (await isBinaryFile(Buffer.from(localBuffer))) {
				throw new Error(i18n.t('sync.error.cannotMergeBinary'))
			}
			const localText = await new Blob([localBuffer]).text()
			const remoteText = await new Blob([remoteBuffer]).text()
			const { record } = this.options
			const baseText = (await record?.base?.text()) ?? remoteText
			const dmp = new diff_match_patch()
			dmp.Match_Threshold = 0.2
			dmp.Patch_Margin = 4
			const diffs = dmp.diff_main(baseText, remoteText)
			const patches = dmp.patch_make(baseText, diffs)
			let [mergedText, solveResult] = dmp.patch_apply(patches, localText)
			if (solveResult.includes(false)) {
				const diff3MergedResult = mergeDigIn(localText, baseText, remoteText, {
					stringSeparator: '\n',
					useGitStyle: this.options.useGitStyle,
				})
				mergedText = diff3MergedResult.result.join('\n')
			}
			const putResult = await this.webdav.putFileContents(
				this.remotePath,
				mergedText,
				{ overwrite: true },
			)
			if (!putResult) {
				throw new Error(i18n.t('sync.error.failedToUploadMerged'))
			}
			await this.vault.adapter.write(this.localPath, mergedText)
			return { success: true }
		} catch (e) {
			consola.error(e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
