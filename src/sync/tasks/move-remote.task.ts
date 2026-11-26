import { isAbsolute, join } from 'path-browserify'
import type { StatModel } from '~/model/stat.model'
import { computeBufferDigest } from '~/sync/utils/file-digest'
import { uploadRemoteFile } from '~/utils/chunked-download'
import { extractHttpStatus } from '~/utils/nutstore-dav-error'
import { isSameTime } from '~/utils/is-same-time'
import { existsLocalPath, readLocalBinary } from '~/utils/local-vault-io'
import { normalizeVaultPath } from '~/utils/normalize-vault-path'
import { statVaultItem } from '~/utils/stat-vault-item'
import { statWebDAVItem } from '~/utils/stat-webdav-item'
import {
	BaseTask,
	BaseTaskOptions,
	toTaskError,
	type ScopeTarget,
} from './task.interface'

export interface MoveRemoteTaskOptions extends BaseTaskOptions {
	fromLocalPath: string
	fromRemotePath: string
	/** Verified local snapshot matching the moved remote bytes during planning. */
	expectedLocalStat?: Extract<StatModel, { isDir: false }>
	/** Remote file snapshot whose ETag must remain unchanged after server-side MOVE. */
	expectedRemoteStat?: Extract<StatModel, { isDir: false }>
}

/**
 * Moves or renames a remote file using WebDAV MOVE when supported, falling back
 * to upload-then-delete only when the server rejects MOVE itself (405/501).
 */
export default class MoveRemoteTask extends BaseTask {
	constructor(readonly options: MoveRemoteTaskOptions) {
		super(options)
	}

	get fromLocalPath(): string {
		return normalizeVaultPath(this.options.fromLocalPath)
	}

	get fromRemotePath(): string {
		return isAbsolute(this.options.fromRemotePath)
			? this.options.fromRemotePath
			: join(this.remoteBaseDir, this.options.fromRemotePath)
	}

	get expectedLocalStat(): Extract<StatModel, { isDir: false }> | undefined {
		return this.options.expectedLocalStat
	}

	get expectedRemoteStat(): Extract<StatModel, { isDir: false }> | undefined {
		return this.options.expectedRemoteStat
	}

	/** Protects both the source and destination paths across partial-scan boundaries. */
	override get scopeTargets(): ScopeTarget[] {
		return [
			{ path: this.fromLocalPath, subtree: true, isDir: false },
			{ path: this.localPath, subtree: true, isDir: false },
		]
	}

	async exec() {
		try {
			const exists = await existsLocalPath(this.vault, this.localPath)
			if (!exists) {
				throw new Error(`cannot find file in local fs: ${this.localPath}`)
			}

			this.logger.info(
				`[MoveRemote] ${this.fromRemotePath} → ${this.remotePath}`,
			)
			try {
				await this.webdav.moveFile(this.fromRemotePath, this.remotePath, {
					overwrite: false,
				})
				const localAfter = await statVaultItem(this.vault, this.localPath)
				if (!localAfter || localAfter.isDir) {
					return {
						success: true,
						receipt: {
							kind: 'unverified',
							movedFromLocalPath: this.fromLocalPath,
						},
					} as const
				}
				const expectedLocal = this.expectedLocalStat
				const editedDuringMove =
					expectedLocal !== undefined &&
					(!isSameTime(localAfter.mtime, expectedLocal.mtime) ||
						localAfter.size !== expectedLocal.size)
				const recordedLocal = editedDuringMove ? expectedLocal : localAfter

				try {
					const remoteStat = await statWebDAVItem(this.webdav, this.remotePath)
					const expectedRemote = this.expectedRemoteStat
					if (
						remoteStat.isDir ||
						!remoteStat.etag ||
						remoteStat.size !== recordedLocal.size ||
						(expectedRemote &&
							(!expectedRemote.etag || remoteStat.etag !== expectedRemote.etag))
					) {
						return {
							success: true,
							receipt: {
								kind: 'unverified',
								movedFromLocalPath: this.fromLocalPath,
							},
						} as const
					}
					return {
						success: true,
						receipt: {
							kind: 'synced',
							local: recordedLocal,
							remote: { ...remoteStat, path: this.localPath },
							movedFromLocalPath: this.fromLocalPath,
						},
					} as const
				} catch {
					return {
						success: true,
						receipt: {
							kind: 'unverified',
							movedFromLocalPath: this.fromLocalPath,
						},
					} as const
				}
			} catch (moveError) {
				const status = extractHttpStatus(moveError)
				if (status !== 405 && status !== 501) {
					throw moveError
				}
				this.logger.warn(
					`[MoveRemote] MOVE unsupported (${status}), falling back to upload+delete: ${this.fromRemotePath} → ${this.remotePath}`,
				)
				const localBefore = await statVaultItem(this.vault, this.localPath)
				if (!localBefore || localBefore.isDir) {
					throw new Error(`cannot find file in local fs: ${this.localPath}`, {
						cause: moveError,
					})
				}
				const content = await readLocalBinary(this.vault, this.localPath)
				const localAfterRead = await statVaultItem(this.vault, this.localPath)
				const uploaded = await uploadRemoteFile({
					webdav: this.webdav,
					remotePath: this.remotePath,
					content,
				})
				await this.webdav.deleteFile(this.fromRemotePath)

				const localUnchanged =
					localAfterRead &&
					!localAfterRead.isDir &&
					isSameTime(localAfterRead.mtime, localBefore.mtime) &&
					localAfterRead.size === content.byteLength
				if (!localUnchanged) {
					return {
						success: true,
						receipt: {
							kind: 'unverified',
							movedFromLocalPath: this.fromLocalPath,
						},
					} as const
				}

				try {
					const remoteStat = await statWebDAVItem(this.webdav, this.remotePath)
					if (
						remoteStat.isDir ||
						!remoteStat.etag ||
						remoteStat.size !== content.byteLength ||
						(uploaded.etag && remoteStat.etag !== uploaded.etag)
					) {
						return {
							success: true,
							receipt: {
								kind: 'unverified',
								movedFromLocalPath: this.fromLocalPath,
							},
						} as const
					}
					const digest = await computeBufferDigest(content, this.localPath)
					return {
						success: true,
						receipt: {
							kind: 'synced',
							local: localBefore,
							remote: { ...remoteStat, path: this.localPath },
							movedFromLocalPath: this.fromLocalPath,
							...digest,
						},
					} as const
				} catch {
					return {
						success: true,
						receipt: {
							kind: 'unverified',
							movedFromLocalPath: this.fromLocalPath,
						},
					} as const
				}
			}
		} catch (e) {
			this.logger.error(
				`[MoveRemote] failed: ${this.fromLocalPath} → ${this.localPath}`,
				e,
			)
			return { success: false, error: toTaskError(e, this) }
		}
	}

	override toJSON() {
		return {
			...super.toJSON(),
			fromLocalPath: this.fromLocalPath,
			fromRemotePath: this.fromRemotePath,
		}
	}
}
