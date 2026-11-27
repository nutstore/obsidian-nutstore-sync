import { normalizePath, Platform, Vault } from 'obsidian'
import { dirname } from 'path-browserify'
import type { WebDAVClient } from 'webdav'
import { parseMobileAppDownloadFileChunkSize } from './download-chunk-size'
import { writeLocalBinary } from './local-vault-io'
import logger from './logger'
import { mkdirsVault } from './mkdirs-vault'

/** Raised when remote content or `ETag` drifts while downloading or assembling chunks. */
export class RemoteVersionDriftError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'RemoteVersionDriftError'
	}
}

export interface FetchRemoteFileOptions {
	webdav: WebDAVClient
	remotePath: string
	remoteSize: number
	expectedEtag?: string | null
	mobileAppDownloadFileChunkSize?: string
}

export interface DownloadRemoteFileOptions extends FetchRemoteFileOptions {
	vault: Vault
	localPath: string
}

export interface FetchedRemoteFile {
	bytes: ArrayBuffer
	etag: string | null
	size: number
	mtime?: number
}

export interface UploadRemoteFileResult {
	etag: string | null
	fileVersion?: number
}

export function normalizeEtagHeader(
	value: string | null | undefined,
): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : null
}

function parseLastModifiedHeader(
	value: string | null | undefined,
): number | undefined {
	if (typeof value !== 'string' || !value.trim()) return undefined
	const parsed = Date.parse(value)
	return Number.isFinite(parsed) ? parsed : undefined
}

export function parseContentRangeHeader(
	header: string | null | undefined,
): { start: number; end: number; total: number } | null {
	if (!header) return null
	const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(header.trim())
	if (!match) return null
	return {
		start: Number.parseInt(match[1], 10),
		end: Number.parseInt(match[2], 10),
		total: Number.parseInt(match[3], 10),
	}
}

/**
 * Fetches remote bytes into memory with strict `ETag` and `Content-Range`
 * verification. Small files (and all desktop files) issue a single `GET`
 * without `Range` to avoid Nutstore's `DELTA_OBJECT` reconstruction overhead.
 */
export async function fetchRemoteFileBytes({
	webdav,
	remotePath,
	remoteSize,
	expectedEtag,
	mobileAppDownloadFileChunkSize,
}: FetchRemoteFileOptions): Promise<FetchedRemoteFile> {
	const chunkSize = parseMobileAppDownloadFileChunkSize(
		mobileAppDownloadFileChunkSize,
	)
	const pinnedExpected = normalizeEtagHeader(expectedEtag)

	if (!Platform.isMobileApp || remoteSize <= chunkSize) {
		const response = await webdav.customRequest(remotePath, {
			method: 'GET',
		})
		if (response.status !== 200) {
			throw new Error(`Download failed with status ${response.status}`)
		}
		const responseEtag = normalizeEtagHeader(response.headers.get('etag'))
		const responseMtime = parseLastModifiedHeader(
			response.headers.get('last-modified'),
		)
		if (pinnedExpected && responseEtag !== pinnedExpected) {
			throw new RemoteVersionDriftError(
				`Remote ETag mismatch during download: expected ${pinnedExpected}, got ${responseEtag ?? 'none'}`,
			)
		}
		const bytes = await response.arrayBuffer()
		if (bytes.byteLength !== remoteSize) {
			throw new Error('Remote Size Not Match!')
		}
		return {
			bytes,
			etag: responseEtag ?? pinnedExpected,
			size: bytes.byteLength,
			...(responseMtime !== undefined ? { mtime: responseMtime } : {}),
		}
	}

	// Fill one buffer so peak assembly memory is the file plus the current chunk.
	// Note: Obsidian's requestUrl buffers each response body before returning, so
	// rejecting status 200 prevents corrupt chunk assembly rather than response buffering.
	const content = new ArrayBuffer(remoteSize)
	const contentView = new Uint8Array(content)
	let activeEtag = pinnedExpected
	let responseMtime: number | undefined
	let offset = 0
	let chunkIndex = 0

	logger.info(
		`[ChunkedDownload] start ${remotePath} (${remoteSize} bytes, chunkSize=${chunkSize})`,
	)

	while (offset < remoteSize) {
		const end = Math.min(offset + chunkSize, remoteSize) - 1
		const headers: Record<string, string> = {
			Range: `bytes=${offset}-${end}`,
		}
		if (activeEtag) {
			headers['If-Range'] = activeEtag
		}
		const response = await webdav.customRequest(remotePath, {
			method: 'GET',
			headers,
		})
		if (response.status === 200) {
			throw new RemoteVersionDriftError(
				`If-Range mismatched (HTTP 200) while downloading ${remotePath}`,
			)
		}
		if (response.status !== 206) {
			throw new Error(`Range download failed with status ${response.status}`)
		}
		const contentRange = parseContentRangeHeader(
			response.headers.get('content-range'),
		)
		if (
			!contentRange ||
			contentRange.start !== offset ||
			contentRange.end !== end ||
			contentRange.total !== remoteSize
		) {
			throw new RemoteVersionDriftError(
				`Content-Range mismatch on ${remotePath}: expected ${offset}-${end}/${remoteSize}, got ${response.headers.get('content-range') ?? 'none'}`,
			)
		}
		const chunkEtag = normalizeEtagHeader(response.headers.get('etag'))
		if (activeEtag && chunkEtag !== activeEtag) {
			throw new RemoteVersionDriftError(
				`Remote ETag drifted mid-download on ${remotePath}: expected ${activeEtag}, got ${chunkEtag ?? 'none'}`,
			)
		}
		if (!activeEtag && chunkEtag) {
			activeEtag = chunkEtag
		}
		if (!activeEtag && end + 1 < remoteSize) {
			throw new RemoteVersionDriftError(
				`Remote did not provide an ETag on first chunk of ${remotePath}; refusing unpinned multi-chunk assembly`,
			)
		}
		if (responseMtime === undefined) {
			responseMtime = parseLastModifiedHeader(
				response.headers.get('last-modified'),
			)
		}
		const chunk = await response.arrayBuffer()
		const expectedLength = end - offset + 1
		if (chunk.byteLength !== expectedLength) {
			throw new Error('Remote chunk size not match!')
		}
		contentView.set(new Uint8Array(chunk), offset)
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
	logger.info(`[ChunkedDownload] done ${remotePath} (${chunkIndex} chunks)`)
	return {
		bytes: content,
		etag: activeEtag,
		size: remoteSize,
		...(responseMtime !== undefined ? { mtime: responseMtime } : {}),
	}
}

export async function downloadRemoteFile(
	options: DownloadRemoteFileOptions,
): Promise<FetchedRemoteFile> {
	const fetched = await fetchRemoteFileBytes(options)
	const normalizedLocalPath = normalizePath(options.localPath)
	await mkdirsVault(options.vault, dirname(normalizedLocalPath))
	await writeLocalBinary(options.vault, normalizedLocalPath, fetched.bytes)
	return fetched
}

/**
 * Uploads file contents, enforcing conditional `If-Match` when overwriting a
 * known remote version (see contract in `src/api/webdav.ts`):
 * - `If-Match` requires an exact ETag (`*` is compared literally → `412`);
 *   never pass it when creating a new file (returns `409`).
 * - Nutstore silently ignores `If-None-Match: *` (`204`, overwrites), so
 *   create-only uploads cannot rely on it to guard against concurrent creates.
 */
export async function uploadRemoteFile(options: {
	webdav: WebDAVClient
	remotePath: string
	content: ArrayBuffer | string
	ifMatch?: string | null
}): Promise<UploadRemoteFileResult> {
	const { webdav, remotePath, content, ifMatch } = options
	if (typeof webdav.customRequest !== 'function') {
		const ok = await webdav.putFileContents(remotePath, content, {
			overwrite: true,
		})
		if (!ok) {
			throw new Error('Upload failed')
		}
		return { etag: null }
	}
	const headers: Record<string, string> = {
		'Content-Type': 'application/octet-stream',
	}
	const pinnedEtag = normalizeEtagHeader(ifMatch)
	if (pinnedEtag) {
		headers['If-Match'] = pinnedEtag
	}
	const response = await webdav.customRequest(remotePath, {
		method: 'PUT',
		headers,
		data: content,
	})
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Upload failed with status ${response.status}`)
	}
	const rawVersion = response.headers.get('x-file-version')
	const parsedVersion = rawVersion ? Number.parseInt(rawVersion, 10) : NaN
	return {
		etag: normalizeEtagHeader(response.headers.get('etag')),
		fileVersion: Number.isFinite(parsedVersion) ? parsedVersion : undefined,
	}
}
