import { isAbsolute, join } from 'path-browserify'
import type { StatModel } from '~/model/stat.model'
import i18n from '~/i18n'
import { extractHttpStatus } from '~/utils/nutstore-dav-error'
import { isSameTime } from '~/utils/is-same-time'
import { existsLocalPath } from '~/utils/local-vault-io'
import { normalizeVaultPath } from '~/utils/normalize-vault-path'
import { statVaultItem } from '~/utils/stat-vault-item'
import { statWebDAVItem } from '~/utils/stat-webdav-item'
import {
	BaseTask,
	BaseTaskOptions,
	TaskError,
	toTaskError,
	type ScopeTarget,
} from './task.interface'

export interface MoveRemoteTaskOptions extends BaseTaskOptions {
	fromLocalPath: string
	fromRemotePath: string
	/** Verified local snapshot matching the moved remote bytes during planning. */
	expectedLocalStat?: Extract<StatModel, { isDir: false }>
	/**
	 * Verbatim source ETag observed during planning. Gates the MOVE: a source
	 * that no longer matches it is left untouched instead of being relocated.
	 */
	expectedRemoteEtag: string
}

/**
 * Moves or renames a remote file on Nutstore via WebDAV `MOVE` (`Overwrite: F`).
 * Nutstore natively supports `MOVE`, so no 405/501 upload+delete fallback is
 * kept; see the Nutstore WebDAV server contract in `src/api/webdav.ts`.
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

	get expectedRemoteEtag(): string {
		return this.options.expectedRemoteEtag
	}

	/**
	 * Reports why the planned source version is gone, or `null` when the server
	 * still answers with the ETag observed during planning.
	 *
	 * Nutstore ignores `If-Match`/`If-Unmodified-Since` on `MOVE` (see contract
	 * in `src/api/webdav.ts`), so a pre-MOVE `PROPFIND Depth: 0` narrows the
	 * drift window to one RTT. Failing here also registers `fromLocalPath` in
	 * `failedMoveSources` (`src/sync/index.ts`) so parent `RemoveRemoteTask`s
	 * do not delete the drifted source.
	 */
	private async detectSourceDrift(plannedEtag: string): Promise<string | null> {
		if (!plannedEtag) return 'planned ETag is empty'
		try {
			const current = await statWebDAVItem(this.webdav, this.fromRemotePath)
			if (current.isDir) return 'source is now a directory'
			if (!current.etag) return 'source has no ETag'
			return current.etag === plannedEtag
				? null
				: `etag ${plannedEtag} → ${current.etag}`
		} catch (error) {
			if (extractHttpStatus(error) === 404) return 'source is missing'
			throw error
		}
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

			const drift = await this.detectSourceDrift(this.expectedRemoteEtag)
			if (drift) {
				this.logger.warn(
					`[MoveRemote] skipped, source drifted (${drift}): ${this.fromRemotePath}`,
				)
				return {
					success: false,
					error: new TaskError(i18n.t('sync.error.moveSourceChanged'), this),
				} as const
			}

			// Nutstore returns 409 (not RFC 412) when `Overwrite: F` hits an existing target.
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
				// Nutstore preserves ETag across MOVE and changes it on any overwrite,
				// so a mismatch here catches edits that landed in the 1-RTT window.
				const remoteStat = await statWebDAVItem(this.webdav, this.remotePath)
				if (
					remoteStat.isDir ||
					!remoteStat.etag ||
					remoteStat.size !== recordedLocal.size ||
					remoteStat.etag !== this.expectedRemoteEtag
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
