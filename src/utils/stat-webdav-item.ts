import { basename, isAbsolute, normalize } from 'path-browserify'
import { FileStat, WebDAVClient } from 'webdav'
import { parsePropfindXml, PROPFIND_REQUEST_BODY } from '~/api/webdav'
import { fileStatToStatModel } from './file-stat-to-stat-model'

function normalizeCanonical(path: string): string {
	const normalized = normalize(path)
	return normalized.length > 1 && normalized.endsWith('/')
		? normalized.slice(0, -1)
		: normalized
}

/**
 * Fetches an atomic remote metadata snapshot via `PROPFIND Depth: 0` when the
 * client exposes `customRequest`, preserving verbatim ETags without quote stripping.
 */
export async function statWebDAVItem(client: WebDAVClient, path: string) {
	if (!isAbsolute(path)) {
		throw new Error('stat WebDAV item, path must be absolute: ' + path)
	}
	const canonical = normalizeCanonical(path)
	if (typeof client.customRequest === 'function') {
		const response = await client.customRequest(canonical, {
			method: 'PROPFIND',
			headers: {
				'Content-Type': 'application/xml',
				Depth: '0',
			},
			data: PROPFIND_REQUEST_BODY,
		})
		const xmlText = await response.text()
		const entries = parsePropfindXml(xmlText, '', canonical)
		const matched = entries[0]
		if (!matched) {
			throw new Error(`Empty PROPFIND response for path: ${canonical}`)
		}
		return fileStatToStatModel({
			...matched,
			filename: canonical,
			basename: basename(canonical) || matched.basename,
		})
	}
	const stat = (await client.stat(canonical, {
		details: false,
	})) as FileStat
	return fileStatToStatModel(stat)
}
