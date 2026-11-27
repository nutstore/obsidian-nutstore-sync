import i18n from '~/i18n'
import { StatModel } from '~/model/stat.model'
import { SyncRecordModel } from '~/model/sync-record.model'
import { blobStore } from '~/storage/blob'
import { computeBufferDigest } from '~/sync/utils/file-digest'
import { isMergeablePath } from '~/sync/utils/is-mergeable-path'
import { arrayBufferEquals } from '~/utils/array-buffer-equals'
import {
	downloadRemoteFile,
	fetchRemoteFileBytes,
	uploadRemoteFile,
} from '~/utils/chunked-download'
import { isSameTime } from '~/utils/is-same-time'
import {
	existsLocalPath,
	readLocalBinary,
	writeLocalBinary,
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
				if (!remote.etag) {
					return {
						success: true,
						receipt: { kind: 'unverified' },
					} as const
				}
				const digest = await computeBufferDigest(
					new ArrayBuffer(0),
					this.localPath,
				)
				return {
					success: true,
					receipt: {
						kind: 'synced',
						local,
						remote: { ...remote, path: this.localPath },
						...digest,
					},
				} as const
			}

			switch (this.options.strategy) {
				case ConflictStrategy.NoConflictMerge:
					return await this.execMerge(
						resolveByIntelligentMerge,
						'NoConflictMerge',
						remote,
					)
				case ConflictStrategy.Diff3:
					return await this.execMerge(resolveByDiff3Merge, 'Diff3', remote)
				case ConflictStrategy.LocalPriority:
					return await this.execLocalPriority(remote)
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

	async execLocalPriority(remote?: Extract<StatModel, { isDir: false }>) {
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
			const localBefore = await statVaultItem(this.vault, this.localPath)
			if (!localBefore || localBefore.isDir) {
				throw new Error('cannot find file in local fs: ' + this.localPath)
			}
			const localContent = await readLocalBinary(this.vault, this.localPath)
			const localAfterRead = await statVaultItem(this.vault, this.localPath)
			const uploaded = await uploadRemoteFile({
				webdav: this.webdav,
				remotePath: this.remotePath,
				content: localContent,
				ifMatch: remote?.etag,
			})

			const localUnchanged =
				localAfterRead &&
				!localAfterRead.isDir &&
				isSameTime(localAfterRead.mtime, localBefore.mtime) &&
				localAfterRead.size === localContent.byteLength
			if (!localUnchanged) {
				return {
					success: true,
					receipt: { kind: 'unverified' },
				} as const
			}

			try {
				const remoteStat = await statWebDAVItem(this.webdav, this.remotePath)
				if (
					remoteStat.isDir ||
					!remoteStat.etag ||
					remoteStat.size !== localContent.byteLength ||
					(uploaded.etag && remoteStat.etag !== uploaded.etag)
				) {
					return {
						success: true,
						receipt: { kind: 'unverified' },
					} as const
				}
				const digest = await computeBufferDigest(localContent, this.localPath)
				return {
					success: true,
					receipt: {
						kind: 'synced',
						local: localBefore,
						remote: { ...remoteStat, path: this.localPath },
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
			const downloaded = await downloadRemoteFile({
				vault: this.vault,
				webdav: this.webdav,
				remotePath: this.remotePath,
				localPath: this.localPath,
				remoteSize: remote.size,
				expectedEtag: remote.etag,
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
						...remote,
						path: this.localPath,
						size: downloaded.size,
						mtime: downloaded.mtime ?? remote.mtime,
						etag: downloaded.etag,
					},
					...digest,
				},
			} as const
		} catch (e) {
			this.logger.error(
				`[ConflictResolve/ServerPriority] failed: ${this.localPath}`,
				e,
			)
			return { success: false, error: toTaskError(e, this) }
		}
	}

	private async isLocalSnapshotCurrent(
		expected: Extract<StatModel, { isDir: false }>,
		expectedBytes: ArrayBuffer,
	): Promise<boolean> {
		const current = await statVaultItem(this.vault, this.localPath)
		if (
			!current ||
			current.isDir ||
			!isSameTime(current.mtime, expected.mtime) ||
			current.size !== expectedBytes.byteLength
		) {
			return false
		}
		const currentBytes = await readLocalBinary(this.vault, this.localPath)
		return arrayBufferEquals(currentBytes, expectedBytes)
	}

	private async readLocalMergeSnapshot(): Promise<{
		localBefore: Extract<StatModel, { isDir: false }>
		localBuffer: ArrayBuffer
		localSnapshotValid: boolean
	}> {
		const exists = await existsLocalPath(this.vault, this.localPath)
		if (!exists) {
			throw new Error('cannot find file in local fs: ' + this.localPath)
		}
		const localBefore = await statVaultItem(this.vault, this.localPath)
		if (!localBefore || localBefore.isDir) {
			throw new Error('cannot find file in local fs: ' + this.localPath)
		}
		const localBuffer = await readLocalBinary(this.vault, this.localPath)
		const localAfterRead = await statVaultItem(this.vault, this.localPath)
		const localSnapshotValid =
			Boolean(localAfterRead) &&
			!localAfterRead!.isDir &&
			isSameTime(localAfterRead!.mtime, localBefore.mtime) &&
			localAfterRead!.size === localBuffer.byteLength
		return { localBefore, localBuffer, localSnapshotValid }
	}

	async execMerge(
		resolver: (
			params: IntelligentMergeParams,
		) => IntelligentMergeResult | Promise<IntelligentMergeResult>,
		strategyName: string,
		remote?: Extract<StatModel, { isDir: false }>,
	) {
		try {
			const resolvedRemote =
				remote ??
				(await (async () => {
					const stat = await statWebDAVItem(this.webdav, this.remotePath)
					if (stat.isDir) {
						throw new Error('Remote path is a directory: ' + this.remotePath)
					}
					return stat
				})())

			let snapshot = await this.readLocalMergeSnapshot()

			const fetched = await fetchRemoteFileBytes({
				webdav: this.webdav,
				remotePath: this.remotePath,
				remoteSize: resolvedRemote.size,
				expectedEtag: resolvedRemote.etag,
				mobileAppDownloadFileChunkSize:
					this.options.mobileAppDownloadFileChunkSize,
			})
			const remoteBuffer = fetched.bytes
			const pinnedRemote: Extract<StatModel, { isDir: false }> = {
				...resolvedRemote,
				path: this.localPath,
				size: fetched.size,
				mtime: fetched.mtime ?? resolvedRemote.mtime,
				etag: fetched.etag,
			}

			const { record } = this.options
			let baseBlob: Blob | null = null
			const baseKey = record?.base?.key
			if (baseKey) {
				baseBlob = await blobStore.get(baseKey)
			}

			const maxLocalRemergeAttempts = 2
			for (let attempt = 0; attempt < maxLocalRemergeAttempts; attempt++) {
				if (attempt > 0) {
					try {
						snapshot = await this.readLocalMergeSnapshot()
					} catch {
						return {
							success: true,
							receipt: { kind: 'unverified' },
						} as const
					}
				}
				const { localBefore, localBuffer, localSnapshotValid } = snapshot
				const canRetryRemerge = attempt + 1 < maxLocalRemergeAttempts

				if (arrayBufferEquals(localBuffer, remoteBuffer)) {
					if (!pinnedRemote.etag) {
						return {
							success: true,
							receipt: { kind: 'unverified' },
						} as const
					}
					if (
						!localSnapshotValid ||
						!(await this.isLocalSnapshotCurrent(localBefore, localBuffer))
					) {
						if (canRetryRemerge) continue
						return {
							success: true,
							receipt: { kind: 'unverified' },
						} as const
					}
					const digest = await computeBufferDigest(localBuffer, this.localPath)
					return {
						success: true,
						receipt: {
							kind: 'synced',
							local: localBefore,
							remote: pinnedRemote,
							...digest,
						},
					} as const
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

				const mergedText = mergeResult.isIdentical
					? remoteText
					: mergeResult.mergedText!

				// Remote-wins (including decoded-equal but byte-different BOM mismatches):
				// write raw remote bytes only if local has not changed during fetch/merge.
				if (mergeResult.isIdentical || mergedText === remoteText) {
					if (
						!localSnapshotValid ||
						!(await this.isLocalSnapshotCurrent(localBefore, localBuffer))
					) {
						if (canRetryRemerge) continue
						return {
							success: true,
							receipt: { kind: 'unverified' },
						} as const
					}
					// Write raw remote bytes so UTF-8 BOM or non-canonical byte sequences stay byte-identical.
					await writeLocalBinary(this.vault, this.localPath, remoteBuffer)
					const localAfter = await statVaultItem(this.vault, this.localPath)
					if (
						!pinnedRemote.etag ||
						!localAfter ||
						localAfter.isDir ||
						localAfter.size !== remoteBuffer.byteLength
					) {
						return {
							success: true,
							receipt: { kind: 'unverified' },
						} as const
					}
					const digest = await computeBufferDigest(remoteBuffer, this.localPath)
					return {
						success: true,
						receipt: {
							kind: 'synced',
							local: localAfter,
							remote: pinnedRemote,
							...digest,
						},
					} as const
				}

				// Re-verify local snapshot before uploading so edits made during GET trigger re-merge.
				if (
					!localSnapshotValid ||
					!(await this.isLocalSnapshotCurrent(localBefore, localBuffer))
				) {
					if (canRetryRemerge) continue
					return {
						success: true,
						receipt: { kind: 'unverified' },
					} as const
				}

				const localWins = mergedText === localText
				// Upload raw local bytes when local wins so UTF-8 BOM and exact byte sequences match both sides.
				const uploadBytes = localWins
					? localBuffer
					: (() => {
							const encoded = new TextEncoder().encode(mergedText)
							return encoded.buffer.slice(
								encoded.byteOffset,
								encoded.byteOffset + encoded.byteLength,
							)
						})()

				const uploaded = await uploadRemoteFile({
					webdav: this.webdav,
					remotePath: this.remotePath,
					content: uploadBytes,
					ifMatch: fetched.etag,
				})

				let recordedLocal: Extract<StatModel, { isDir: false }>
				if (!localWins) {
					// Never overwrite local edits made while the merged result was uploading.
					if (!(await this.isLocalSnapshotCurrent(localBefore, localBuffer))) {
						return {
							success: true,
							receipt: { kind: 'unverified' },
						} as const
					}
					await writeLocalBinary(this.vault, this.localPath, uploadBytes)
					const localAfter = await statVaultItem(this.vault, this.localPath)
					if (
						!localAfter ||
						localAfter.isDir ||
						localAfter.size !== uploadBytes.byteLength
					) {
						return {
							success: true,
							receipt: { kind: 'unverified' },
						} as const
					}
					recordedLocal = localAfter
				} else {
					// Local file was not rewritten; only stamp the pre-upload snapshot if still unchanged.
					if (!(await this.isLocalSnapshotCurrent(localBefore, localBuffer))) {
						return {
							success: true,
							receipt: { kind: 'unverified' },
						} as const
					}
					recordedLocal = localBefore
				}

				try {
					const remoteStat = await statWebDAVItem(this.webdav, this.remotePath)
					if (
						remoteStat.isDir ||
						!remoteStat.etag ||
						remoteStat.size !== uploadBytes.byteLength ||
						(uploaded.etag && remoteStat.etag !== uploaded.etag)
					) {
						return {
							success: true,
							receipt: { kind: 'unverified' },
						} as const
					}
					const digest = await computeBufferDigest(uploadBytes, this.localPath)
					return {
						success: true,
						receipt: {
							kind: 'synced',
							local: recordedLocal,
							remote: { ...remoteStat, path: this.localPath },
							...digest,
						},
					} as const
				} catch {
					return {
						success: true,
						receipt: { kind: 'unverified' },
					} as const
				}
			}

			return {
				success: true,
				receipt: { kind: 'unverified' },
			} as const
		} catch (e) {
			this.logger.error(
				`[ConflictResolve/${strategyName}] failed: ${this.localPath}`,
				e,
			)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}
