import consola from 'consola'
import dayjs from 'dayjs'
import { diff_match_patch } from 'diff-match-patch'
import { isBinaryFile } from 'isbinaryfile'
import { BufferLike } from 'webdav'
import { SyncRecordModel } from '~/model/sync-record.model'
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
		},
	) {
		super(options)
	}

	async exec() {
		switch (this.options.strategy) {
			case ConflictStrategy.DiffMatchPatch:
				return this.execDiffMatchPatch()
			case ConflictStrategy.LatestTimeStamp:
				return this.execLatestTimeStamp()
		}
	}

	async execLatestTimeStamp() {
		try {
			const local = await statVaultItem(this.vault, this.localPath)
			if (!local) {
				return {
					success: false,
					error: new Error('Local file not found: ' + this.localPath),
				}
			}
			const remote = await statWebDAVItem(this.webdav, this.remotePath)
			const localMtime = dayjs(local.mtime)
			const remoteMtime = dayjs(remote.mtime)
			const useRemote = remoteMtime.isAfter(localMtime)
			if (useRemote) {
				const file = (await this.webdav.getFileContents(this.remotePath, {
					details: false,
					format: 'binary',
				})) as BufferLike
				await this.vault.adapter.writeBinary(this.localPath, file)
			} else {
				const file = await this.vault.adapter.readBinary(this.localPath)
				await this.webdav.putFileContents(this.remotePath, file, {
					overwrite: true,
				})
			}
			return { success: true }
		} catch (e) {
			consola.error(e)
			return { success: false, error: toTaskError(e) }
		}
	}

	async execDiffMatchPatch() {
		try {
			const localBuffer = await this.vault.adapter.readBinary(this.localPath)
			if (await isBinaryFile(Buffer.from(localBuffer))) {
				return {
					success: false,
					error: new Error('Cannot merge binary file'),
				}
			}
			const localText = await new Blob([localBuffer]).text()
			const remoteText = (await this.webdav.getFileContents(this.remotePath, {
				format: 'text',
				details: false,
			})) as string
			const { record } = this.options
			const baseText = (await record?.base?.text()) ?? remoteText
			const dmp = new diff_match_patch()
			const diffs = dmp.diff_main(baseText, remoteText)
			dmp.diff_cleanupSemantic(diffs)
			const patch = dmp.patch_make(baseText, diffs)
			const [mergedText, solveResult] = dmp.patch_apply(patch, localText)
			consola.debug('mergedText', mergedText)
			if (solveResult.includes(false)) {
				return {
					success: false,
					error: new Error('Failed to auto merge'),
				}
			}
			const putResult = await this.webdav.putFileContents(
				this.remotePath,
				mergedText,
				{ overwrite: true },
			)
			if (!putResult) {
				return {
					success: false,
					error: new Error('Failed to upload merged content'),
				}
			}
			await this.vault.adapter.write(this.localPath, mergedText)
			return { success: true }
		} catch (e) {
			consola.error(e)
			return { success: false, error: toTaskError(e) }
		}
	}
}
