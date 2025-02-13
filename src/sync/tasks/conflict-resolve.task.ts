import { diff_match_patch } from 'diff-match-patch'
import { isBinaryFile } from 'isbinaryfile'
import { noop } from 'lodash-es'
import { SyncRecordModel } from '~/model/sync-record.model'
import { statVaultItem } from '~/utils/stat-vault-item'
import { statWebDAVItem } from '~/utils/stat-webdav-item'
import { BaseTask, BaseTaskOptions } from './task.interface'

export default class ConflictResolveTask extends BaseTask {
	constructor(
		public readonly options: BaseTaskOptions & {
			record?: SyncRecordModel
		},
	) {
		super(options)
	}

	async exec() {
		const lock = await this.webdav.lock(this.remotePath)
		try {
			const localBuffer = await this.vault.adapter.readBinary(this.localPath)
			if (await isBinaryFile(Buffer.from(localBuffer))) {
				throw new Error(`Cannot merge binary file!`)
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
			console.debug('mergedText', mergedText)
			if (solveResult.includes(false)) {
				throw new Error('failed to auto merge')
			}
			await this.webdav.unlock(this.remotePath, lock.token)
			const putResult = await this.webdav.putFileContents(
				this.remotePath,
				mergedText,
				{
					overwrite: true,
				},
			)
			if (!putResult) {
				throw new Error('failed to webdav.putFileContents')
			}
			await this.vault.adapter.write(this.localPath, mergedText)
			await this.syncRecord.updateFileRecord(this.localPath, {
				local: (await statVaultItem(this.vault, this.localPath))!,
				remote: await statWebDAVItem(this.webdav, this.remotePath),
				base: new Blob([localText]),
			})
			return true
		} catch (e) {
			console.error(this, e)
			return false
		} finally {
			await this.webdav.unlock(this.remotePath, lock.token).catch(noop)
		}
	}
}
