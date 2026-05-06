import { dirname } from 'path-browserify'
import { BufferLike } from 'webdav'
import logger from '~/utils/logger'
import { writeLocalBinary } from '~/utils/local-vault-io'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import { BaseTask, BaseTaskOptions, toTaskError } from './task.interface'

export default class PullTask extends BaseTask {
	constructor(
		readonly options: BaseTaskOptions & {
			remoteSize: number
		},
	) {
		super(options)
	}

	get remoteSize() {
		return this.options.remoteSize
	}

	async exec() {
		try {
			const file = (await this.webdav.getFileContents(this.remotePath, {
				format: 'binary',
				details: false,
			})) as BufferLike
			const arrayBuffer = bufferLikeToArrayBuffer(file)
			if (arrayBuffer.byteLength !== this.remoteSize) {
				throw new Error('Remote Size Not Match!')
			}
			await mkdirsVault(this.vault, dirname(this.localPath))
			await writeLocalBinary(this.vault, this.localPath, arrayBuffer)
			return { success: true } as const
		} catch (e) {
			logger.error(this, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}

function bufferLikeToArrayBuffer(buffer: BufferLike): ArrayBuffer {
	if (buffer instanceof ArrayBuffer) {
		return buffer
	} else {
		return toArrayBuffer(buffer)
	}
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
	if (buf.buffer instanceof SharedArrayBuffer) {
		const copy = new ArrayBuffer(buf.byteLength)
		new Uint8Array(copy).set(buf)
		return copy
	}
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}
