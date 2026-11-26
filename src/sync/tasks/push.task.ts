import { computeBufferDigest } from '~/sync/utils/file-digest'
import { uploadRemoteFile } from '~/utils/chunked-download'
import { isSameTime } from '~/utils/is-same-time'
import { existsLocalPath, readLocalBinary } from '~/utils/local-vault-io'
import { statVaultItem } from '~/utils/stat-vault-item'
import { statWebDAVItem } from '~/utils/stat-webdav-item'
import { BaseTask, BaseTaskOptions, toTaskError } from './task.interface'

export interface PushTaskOptions extends BaseTaskOptions {
	expectedRemoteEtag?: string | null
}

export default class PushTask extends BaseTask {
	constructor(readonly options: PushTaskOptions) {
		super(options)
	}

	async exec() {
		try {
			const exists = await existsLocalPath(this.vault, this.localPath)
			if (!exists) {
				throw new Error('cannot find file in local fs: ' + this.localPath)
			}

			const localBefore = await statVaultItem(this.vault, this.localPath)
			if (!localBefore || localBefore.isDir) {
				throw new Error('cannot find file in local fs: ' + this.localPath)
			}

			const content = await readLocalBinary(this.vault, this.localPath)
			const localAfterRead = await statVaultItem(this.vault, this.localPath)
			this.logger.info(
				`[PushTask] ${this.localPath} → ${this.remotePath} (${content.byteLength} bytes)`,
			)
			const uploaded = await uploadRemoteFile({
				webdav: this.webdav,
				remotePath: this.remotePath,
				content,
				ifMatch: this.options.expectedRemoteEtag,
			})

			const localUnchanged =
				localAfterRead &&
				!localAfterRead.isDir &&
				isSameTime(localAfterRead.mtime, localBefore.mtime) &&
				localAfterRead.size === content.byteLength
			if (!localUnchanged) {
				return {
					success: true,
					receipt: { kind: 'unverified' },
				} as const
			}

			try {
				// Nutstore PUT returns `x-file-version` without `ETag`, whereas PROPFIND returns
				// `ETag` without `x-file-version`. Verify byte size and, when present, PUT ETag.
				const remoteStat = await statWebDAVItem(this.webdav, this.remotePath)
				if (
					remoteStat.isDir ||
					!remoteStat.etag ||
					remoteStat.size !== content.byteLength ||
					(uploaded.etag && remoteStat.etag !== uploaded.etag)
				) {
					return {
						success: true,
						receipt: { kind: 'unverified' },
					} as const
				}
				const digest = await computeBufferDigest(content, this.localPath)
				return {
					success: true,
					receipt: {
						kind: 'synced',
						local: localBefore,
						remote: {
							...remoteStat,
							path: this.localPath,
						},
						...digest,
					},
				} as const
			} catch {
				return {
					success: true,
					receipt: { kind: 'unverified' },
				} as const
			}
		} catch (e) {
			this.logger.error(`[PushTask] failed: ${this.localPath}`, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
