import { dirname } from 'path'
import { BufferLike } from 'webdav'
import logger from '~/utils/logger'
import { mkdirsVault } from '~/utils/mkdirs-vault'
import { BaseTask, toTaskError } from './task.interface'

export default class PullTask extends BaseTask {
	async exec() {
		const fileExists = await this.vault.getFileByPath(this.localPath)
		try {
			const file = (await this.webdav.getFileContents(this.remotePath, {
				format: 'binary',
				details: false,
			})) as BufferLike
			const arrayBuffer = bufferLikeToArrayBuffer(file)
			if (fileExists) {
				await this.vault.modifyBinary(fileExists, arrayBuffer)
			} else {
				await mkdirsVault(this.vault, dirname(this.localPath))
				await this.vault.createBinary(this.localPath, arrayBuffer)
			}
			return { success: true }
		} catch (e) {
			logger.error(this, e)
			return { success: false, error: toTaskError(e, this) }
		}
	}
}

function bufferLikeToArrayBuffer(buffer: BufferLike) {
	if (buffer instanceof ArrayBuffer) {
		return buffer
	} else {
		return toArrayBuffer(buffer)
	}
}

function toArrayBuffer(buffer: Buffer) {
	const arrayBuffer = new ArrayBuffer(buffer.length)
	const view = new Uint8Array(arrayBuffer)
	for (let i = 0; i < buffer.length; ++i) {
		view[i] = buffer[i]
	}
	return arrayBuffer
}
