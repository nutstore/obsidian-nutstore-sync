import { normalizePath, Platform, Vault } from 'obsidian'
import { dirname } from 'path-browserify'
import type { BufferLike, WebDAVClient } from 'webdav'
import { parseMobileAppDownloadFileChunkSize } from './download-chunk-size'
import { writeLocalBinary } from './local-vault-io'
import logger from './logger'
import { mkdirsVault } from './mkdirs-vault'

export interface DownloadRemoteFileOptions {
	vault: Vault
	webdav: WebDAVClient
	remotePath: string
	localPath: string
	remoteSize: number
	mobileAppDownloadFileChunkSize?: string
}

export async function downloadRemoteFile(options: DownloadRemoteFileOptions) {
	if (!Platform.isMobileApp) {
		await downloadRemoteFileWhole(options)
		return
	}
	await downloadRemoteFileInChunks(options)
}

export function bufferLikeToArrayBuffer(buffer: BufferLike): ArrayBuffer {
	if (buffer instanceof ArrayBuffer) {
		return buffer
	}
	return toArrayBuffer(buffer)
}

async function downloadRemoteFileWhole({
	vault,
	webdav,
	remotePath,
	localPath,
	remoteSize,
}: DownloadRemoteFileOptions) {
	const file = (await webdav.getFileContents(remotePath, {
		format: 'binary',
		details: false,
	})) as BufferLike
	const arrayBuffer = bufferLikeToArrayBuffer(file)
	if (arrayBuffer.byteLength !== remoteSize) {
		throw new Error('Remote Size Not Match!')
	}
	await mkdirsVault(vault, dirname(localPath))
	await writeLocalBinary(vault, localPath, arrayBuffer)
}

async function downloadRemoteFileInChunks({
	vault,
	webdav,
	remotePath,
	localPath,
	remoteSize,
	mobileAppDownloadFileChunkSize,
}: DownloadRemoteFileOptions) {
	const normalizedLocalPath = normalizePath(localPath)
	await mkdirsVault(vault, dirname(normalizedLocalPath))

	if (remoteSize === 0) {
		await writeLocalBinary(vault, normalizedLocalPath, new ArrayBuffer(0))
		return
	}

	const appendBinary = vault.adapter.appendBinary?.bind(vault.adapter)
	if (!appendBinary) {
		throw new Error(
			'Obsidian adapter.appendBinary is required for chunked download',
		)
	}

	const chunkSize = parseMobileAppDownloadFileChunkSize(
		mobileAppDownloadFileChunkSize,
	)
	const tempPath = normalizePath(
		`${normalizedLocalPath}.nutstore-sync-${Date.now()}-${Math.random()
			.toString(36)
			.slice(2)}.download`,
	)
	let offset = 0
	let chunkIndex = 0

	logger.info(
		`[ChunkedDownload] start ${remotePath} (${remoteSize} bytes, chunkSize=${chunkSize})`,
	)

	try {
		while (offset < remoteSize) {
			const end = Math.min(offset + chunkSize, remoteSize) - 1
			const response = await webdav.customRequest(remotePath, {
				method: 'GET',
				headers: {
					Range: `bytes=${offset}-${end}`,
				},
			})
			if (response.status !== 206) {
				throw new Error(`Range download failed with status ${response.status}`)
			}
			const chunk = await response.arrayBuffer()
			const expectedLength = end - offset + 1
			if (chunk.byteLength !== expectedLength) {
				throw new Error('Remote chunk size not match!')
			}
			if (offset === 0) {
				await vault.adapter.writeBinary(tempPath, chunk)
			} else {
				await appendBinary(tempPath, chunk)
			}
			offset += chunk.byteLength
			chunkIndex++
			if (chunkIndex % 5 === 0) {
				logger.debug(
					`[ChunkedDownload] progress ${offset}/${remoteSize} bytes (chunk #${chunkIndex})`,
				)
			}
		}

		if (offset !== remoteSize) {
			throw new Error('Remote Size Not Match!')
		}
		if (await vault.adapter.exists(normalizedLocalPath)) {
			await vault.adapter.remove(normalizedLocalPath)
		}
		await vault.adapter.rename(tempPath, normalizedLocalPath)
		logger.info(`[ChunkedDownload] done ${remotePath} (${chunkIndex} chunks)`)
	} catch (error) {
		await removeTempDownload(vault, tempPath)
		throw error
	}
}

async function removeTempDownload(vault: Vault, tempPath: string) {
	try {
		if (await vault.adapter.exists(tempPath)) {
			await vault.adapter.remove(tempPath)
		}
	} catch {
		// Best-effort cleanup only; preserve the original download error.
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
