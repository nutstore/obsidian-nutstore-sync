import { isAbsolute, join } from 'path-browserify'
import type { StatModel } from '~/model/stat.model'
import { describeThrownValue } from '~/utils/error-inspection'
import { existsLocalPath, readLocalBinary } from '~/utils/local-vault-io'
import { normalizeVaultPath } from '~/utils/normalize-vault-path'
import { RequestUrlError } from '~/utils/request-url-error'
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
}

function getHttpStatus(error: unknown): number | undefined {
	if (error instanceof RequestUrlError) {
		return error.res.status
	}
	if (typeof error === 'object' && error !== null) {
		const status = Reflect.get(error, 'status')
		if (typeof status === 'number') return status
		const response = Reflect.get(error, 'response')
		if (typeof response === 'object' && response !== null) {
			const responseStatus = Reflect.get(response, 'status')
			if (typeof responseStatus === 'number') return responseStatus
		}
	}
	const message = describeThrownValue(error, '')
	const match = /\bInvalid response:\s*(\d{3})\b/.exec(message)
	return match ? Number(match[1]) : undefined
}

/**
 * Moves or renames a remote file using WebDAV MOVE when supported, falling back
 * to upload-then-delete only when the server rejects MOVE itself (405/501).
 */
export default class MoveRemoteTask extends BaseTask {
	private _usedFallbackUpload = false

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

	/** True when 405/501 fallback uploaded current local bytes instead of server-side MOVE. */
	get usedFallbackUpload(): boolean {
		return this._usedFallbackUpload
	}

	/** Protects both the source and destination paths across partial-scan boundaries. */
	override get scopeTargets(): ScopeTarget[] {
		return [
			{ path: this.fromLocalPath, subtree: true, isDir: false },
			{ path: this.localPath, subtree: true, isDir: false },
		]
	}

	async exec() {
		this._usedFallbackUpload = false
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
				return { success: true } as const
			} catch (moveError) {
				const status = getHttpStatus(moveError)
				if (status !== 405 && status !== 501) {
					throw moveError
				}
				this.logger.warn(
					`[MoveRemote] MOVE unsupported (${status}), falling back to upload+delete: ${this.fromRemotePath} → ${this.remotePath}`,
				)
				const content = await readLocalBinary(this.vault, this.localPath)
				const uploaded = await this.webdav.putFileContents(
					this.remotePath,
					content,
					{ overwrite: true },
				)
				if (!uploaded) {
					throw new Error('Upload failed', { cause: moveError })
				}
				await this.webdav.deleteFile(this.fromRemotePath)
				this._usedFallbackUpload = true
				return { success: true } as const
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
