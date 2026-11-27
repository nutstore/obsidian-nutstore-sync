import type { StatModel } from '~/model/stat.model'
import { computeBufferDigest } from '~/sync/utils/file-digest'
import { downloadRemoteFile } from '~/utils/chunked-download'
import { statVaultItem } from '~/utils/stat-vault-item'
import { BaseTask, BaseTaskOptions, toTaskError } from './task.interface'

export default class PullTask extends BaseTask {
	constructor(
		readonly options: BaseTaskOptions & {
			remoteSize: number
			expectedRemoteStat?: Extract<StatModel, { isDir: false }>
			mobileAppDownloadFileChunkSize?: string
		},
	) {
		super(options)
	}

	get remoteSize() {
		return this.options.remoteSize
	}

	async exec() {
		try {
			this.logger.info(
				`[PullTask] ${this.remotePath} → ${this.localPath} (${this.remoteSize} bytes)`,
			)
			const expected = this.options.expectedRemoteStat
			const downloaded = await downloadRemoteFile({
				vault: this.vault,
				webdav: this.webdav,
				remotePath: this.remotePath,
				localPath: this.localPath,
				remoteSize: this.remoteSize,
				expectedEtag: expected?.etag,
				mobileAppDownloadFileChunkSize:
					this.options.mobileAppDownloadFileChunkSize,
			})
			const localAfter = await statVaultItem(this.vault, this.localPath)
			if (
				!downloaded.etag ||
				!localAfter ||
				localAfter.isDir ||
				localAfter.size !== downloaded.size
			) {
				return {
					success: true,
					receipt: { kind: 'unverified' },
				} as const
			}
			const digest = await computeBufferDigest(downloaded.bytes, this.localPath)
			return {
				success: true,
				receipt: {
					kind: 'synced',
					local: localAfter,
					remote: {
						path: this.localPath,
						basename: localAfter.basename,
						isDir: false,
						isDeleted: false,
						size: downloaded.size,
						mtime: downloaded.mtime ?? expected?.mtime ?? localAfter.mtime,
						etag: downloaded.etag,
					},
					...digest,
				},
			} as const
		} catch (e) {
			this.logger.error(`[PullTask] failed: ${this.localPath}`, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
