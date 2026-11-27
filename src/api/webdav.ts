/**
 * Nutstore WebDAV server contract (verified live; this plugin targets Nutstore
 * only and does not carry generic WebDAV compatibility fallbacks):
 *
 * - ETags: unquoted, content-addressed; overwrite `PUT` always changes ETag
 *   (even at identical byte length); `MOVE` preserves ETag verbatim (`src === dst`).
 * - Conditional `PUT`: `If-Match: <exact-etag>` returns `412` on mismatch and
 *   `409` when the target does not exist; `If-Match: *` is compared literally
 *   (`412`); `If-None-Match: *` is silently ignored (`204`, overwrites).
 * - Conditional `GET`: `If-None-Match: <etag>` returns `304`; `If-Range: <etag>`
 *   with `Range` returns `206` on match and `200` (full body) on mismatch.
 * - `MOVE` / `DELETE` / `COPY`: silently ignore `If-Match` and `If-Unmodified-Since`.
 * - `MOVE`: natively supported; `Overwrite: F` rejects existing destinations
 *   with `409` (not RFC 4918 `412`).
 * - Metadata quirks: `PROPFIND` emits `<d:getetag>` only when `<resourcetype/>`
 *   or `<getcontenttype/>` is requested; `HEAD 200` omits `ETag` and reports
 *   `Content-Length: 0`; `PUT` returns `x-file-version` without `ETag`, whereas
 *   `PROPFIND` returns `ETag` without `x-file-version`; single `GET` without
 *   `Range` avoids server-side `DELTA_OBJECT` reconstruction overhead.
 */
import { isNil } from 'es-toolkit/compat'
import { XMLParser } from 'fast-xml-parser'
import { decode as decodeHtmlEntities } from 'html-entities'
import { basename, normalize } from 'path-browserify'
import { FileStat } from 'webdav'
import type { StatModel } from '~/model/stat.model'
import type { NutstoreSettings } from '~/settings'
import { apiLimiter } from '~/utils/api-limiter'
import { fileStatToStatModel } from '~/utils/file-stat-to-stat-model'
import { getNutstoreDavEndpoint } from '~/utils/nutstore-endpoints'
import requestUrl from '~/utils/request-url'
import { RequestUrlError } from '~/utils/request-url-error'
import { retryWith503Backoff } from '~/utils/retry-503'
import { xmlTextValue } from '~/utils/xml-text-value'

interface PropfindProp {
	displayname?: unknown
	resourcetype?: unknown
	getlastmodified?: unknown
	getcontentlength?: unknown
	getcontenttype?: unknown
	getetag?: unknown
}

interface PropfindPropstat {
	prop?: PropfindProp
	status?: unknown
}

interface PropfindResponseItem {
	href?: unknown
	status?: unknown
	propstat?: PropfindPropstat | PropfindPropstat[]
}

interface PropfindMultistatus {
	multistatus?: {
		response?: PropfindResponseItem | PropfindResponseItem[]
	}
}

export interface UnreadablePropfindItem {
	path: string
	status?: string
}

export interface PropfindParseResult {
	items: FileStat[]
	unreadable: UnreadablePropfindItem[]
}

export type RemoteStatResult =
	| { status: 'ok'; stat: StatModel }
	| { status: 'not-found' }
	| { status: 'unreadable'; statusText?: string }

/**
 * Nutstore only emits `<d:getetag>` when `<resourcetype/>` or `<getcontenttype/>`
 * is requested in `<d:prop>`. Both are included here.
 */
export const PROPFIND_REQUEST_BODY = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:">
  <prop>
    <displayname/>
    <resourcetype/>
    <getlastmodified/>
    <getcontentlength/>
    <getcontenttype/>
    <getetag/>
  </prop>
</propfind>`

const propfindParser = new XMLParser({
	attributeNamePrefix: '',
	removeNSPrefix: true,
	parseTagValue: false,
	numberParseOptions: {
		eNotation: false,
		hex: true,
		leadingZeros: true,
	},
	processEntities: false,
})

function normalizeCanonicalPath(inputPath: string): string {
	const raw = inputPath.startsWith('/') ? inputPath : `/${inputPath}`
	const normalized = normalize(raw)
	return normalized.length > 1 && normalized.endsWith('/')
		? normalized.slice(0, -1)
		: normalized || '/'
}

function encodeDavPath(path: string): string {
	const canonical = normalizeCanonicalPath(path)
	if (canonical === '/') return '/'
	const encoded = canonical
		.split('/')
		.filter(Boolean)
		.map(encodeURIComponent)
		.join('/')
	const keepTrailingSlash = path.endsWith('/')
	return `/${encoded}${keepTrailingSlash ? '/' : ''}`
}

function getHeaderCaseInsensitive(
	headers: Record<string, string> | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined
	const lower = name.toLowerCase()
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) {
			return value
		}
	}
	return undefined
}

function extractNextLink(linkHeader: string): string | null {
	const matches = linkHeader.match(
		/<([^>]+)>;\s*[^,]*\brel=(?:"[^"]*\bnext\b[^"]*"|next(?=\s*(?:;|,|$)))/i,
	)
	return matches ? matches[1] : null
}

function pickOkPropstat(
	propstat: PropfindPropstat | PropfindPropstat[] | undefined,
): PropfindProp | null {
	if (!propstat) return null
	const list = Array.isArray(propstat) ? propstat : [propstat]
	const merged: PropfindProp = {}
	let matchedOk = false
	for (const entry of list) {
		if (!entry || typeof entry !== 'object') continue
		const status = entry.status
		const isOk =
			status === undefined ||
			(typeof status === 'string' && /\b200\b/.test(status))
		if (!isOk) continue
		matchedOk = true
		if (entry.prop && typeof entry.prop === 'object') {
			Object.assign(merged, entry.prop)
		}
	}
	return matchedOk ? merged : null
}

function isCollectionResource(resourcetype: unknown): boolean {
	if (resourcetype === null || resourcetype === undefined) return false
	if (typeof resourcetype === 'object') {
		return !isNil((resourcetype as { collection?: unknown }).collection)
	}
	return false
}

function decodeHrefToSandboxPath(rawHref: string, serverBase: string): string {
	const entityDecoded = decodeHtmlEntities(rawHref, { level: 'xml' })
	let pathname = entityDecoded
	if (/^https?:\/\//i.test(entityDecoded)) {
		pathname = new URL(entityDecoded).pathname
	}
	const decodedPath = decodeURIComponent(pathname)
	const cleanBase = serverBase === '/' ? '' : serverBase.replace(/\/+$/, '')
	let rel = decodedPath
	if (cleanBase) {
		if (decodedPath === cleanBase || decodedPath === `${cleanBase}/`) {
			rel = '/'
		} else if (decodedPath.startsWith(`${cleanBase}/`)) {
			rel = decodedPath.slice(cleanBase.length)
		}
	}
	return normalizeCanonicalPath(rel)
}

function convertPropfindItemToFileStat(
	serverBase: string,
	item: PropfindResponseItem,
	overrideFilename?: string,
): FileStat | null {
	const props = pickOkPropstat(item.propstat)
	if (!props) {
		return null
	}
	const isDir = isCollectionResource(props.resourcetype)
	const filename = overrideFilename
		? normalizeCanonicalPath(overrideFilename)
		: decodeHrefToSandboxPath(xmlTextValue(item.href, '/'), serverBase)
	// `displayname` is plain XML text (not URI-encoded), so only decode XML entities.
	const displayname =
		typeof props.displayname === 'string'
			? decodeHtmlEntities(props.displayname, { level: 'xml' })
			: ''
	const sizeStr =
		typeof props.getcontentlength === 'string' ? props.getcontentlength : ''
	const size = sizeStr ? Number.parseInt(sizeStr, 10) || 0 : 0
	const lastmod =
		typeof props.getlastmodified === 'string' ? props.getlastmodified : ''
	const mime =
		typeof props.getcontenttype === 'string' ? props.getcontenttype : undefined
	// Preserve ETag verbatim without stripping quotes; directories have no ETag.
	const rawEtag =
		!isDir && typeof props.getetag === 'string' && props.getetag.length > 0
			? decodeHtmlEntities(props.getetag, { level: 'xml' })
			: null

	return {
		filename,
		basename: basename(filename) || displayname,
		lastmod,
		size,
		type: isDir ? 'directory' : 'file',
		etag: rawEtag,
		mime,
	}
}

function extractErrorStatus(
	propstat: PropfindPropstat | PropfindPropstat[] | undefined,
	responseStatus?: unknown,
): string | undefined {
	if (propstat) {
		const list = Array.isArray(propstat) ? propstat : [propstat]
		for (const entry of list) {
			if (!entry || typeof entry !== 'object') continue
			if (typeof entry.status === 'string' && !/\b200\b/.test(entry.status)) {
				const trimmed = entry.status.trim()
				if (trimmed) return trimmed
			}
		}
	}
	if (typeof responseStatus === 'string' && !/\b200\b/.test(responseStatus)) {
		const trimmed = responseStatus.trim()
		if (trimmed) return trimmed
	}
	return undefined
}

/**
 * Parses WebDAV `PROPFIND` `207 Multi-Status` XML into readable `FileStat`
 * records plus any entries whose `<response>` lacked a `200` `<propstat>`.
 */
export function parsePropfindXmlDetailed(
	xmlText: string,
	serverBase: string,
	overrideSingleFilename?: string,
): PropfindParseResult {
	const parsed = propfindParser.parse(xmlText) as PropfindMultistatus
	if (parsed?.multistatus === undefined) {
		throw new Error('Invalid PROPFIND multistatus XML response')
	}
	const rawResponses = parsed.multistatus?.response
	if (!rawResponses) return { items: [], unreadable: [] }
	const rawItems = Array.isArray(rawResponses) ? rawResponses : [rawResponses]
	const stats: FileStat[] = []
	const unreadable: UnreadablePropfindItem[] = []
	rawItems.forEach((item, idx) => {
		if (!item || typeof item !== 'object') return
		const override =
			rawItems.length === 1 && idx === 0 ? overrideSingleFilename : undefined
		const stat = convertPropfindItemToFileStat(serverBase, item, override)
		if (stat) {
			stats.push(stat)
		} else {
			const path = override
				? normalizeCanonicalPath(override)
				: decodeHrefToSandboxPath(xmlTextValue(item.href, '/'), serverBase)
			unreadable.push({
				path,
				status: extractErrorStatus(item.propstat, item.status),
			})
		}
	})
	return { items: stats, unreadable }
}

/** Parses WebDAV `PROPFIND` `207 Multi-Status` XML into `FileStat` records. */
export function parsePropfindXml(
	xmlText: string,
	serverBase: string,
	overrideSingleFilename?: string,
): FileStat[] {
	return parsePropfindXmlDetailed(xmlText, serverBase, overrideSingleFilename)
		.items
}

export async function getDirectoryContents(
	settings: NutstoreSettings,
	token: string,
	path: string,
	throwIfCancelled?: () => void,
	onRetry?: () => void,
	onUnreadableItem?: (item: UnreadablePropfindItem) => void,
): Promise<FileStat[]> {
	const contents: FileStat[] = []
	const seenPaths = new Set<string>()
	const seenUnreadablePaths = new Set<string>()
	const davEndpoint = getNutstoreDavEndpoint(settings)
	const davUrl = new URL(davEndpoint)
	const serverBase = davUrl.pathname
	const requestedCanonical = normalizeCanonicalPath(path)
	let currentUrl = `${davEndpoint}${encodeDavPath(path)}`
	const seenPageUrls = new Set<string>([currentUrl])

	while (true) {
		throwIfCancelled?.()
		const response = await retryWith503Backoff(
			() =>
				apiLimiter.schedule(async () => {
					throwIfCancelled?.()
					return await requestUrl({
						url: currentUrl,
						method: 'PROPFIND',
						headers: {
							Authorization: `Basic ${token}`,
							'Content-Type': 'application/xml',
							Depth: '1',
						},
						body: PROPFIND_REQUEST_BODY,
					})
				}),
			{ throwIfCancelled, onRetry: onRetry ? () => onRetry() : undefined },
		)
		throwIfCancelled?.()

		const { items: pageItems, unreadable } = parsePropfindXmlDetailed(
			response.text,
			serverBase,
		)
		for (const stat of pageItems) {
			const canonical = normalizeCanonicalPath(stat.filename)
			if (canonical === requestedCanonical || seenPaths.has(canonical)) {
				continue
			}
			seenPaths.add(canonical)
			contents.push(stat)
		}
		for (const entry of unreadable) {
			const canonical = normalizeCanonicalPath(entry.path)
			if (seenPaths.has(canonical) || seenUnreadablePaths.has(canonical)) {
				continue
			}
			seenUnreadablePaths.add(canonical)
			onUnreadableItem?.({ ...entry, path: canonical })
		}

		const linkHeader = getHeaderCaseInsensitive(response.headers, 'link')
		if (!linkHeader) {
			break
		}

		const nextLink = extractNextLink(linkHeader)
		if (!nextLink) {
			break
		}
		const nextUrl = new URL(nextLink, currentUrl)
		if (nextUrl.origin !== davUrl.origin) {
			throw new Error('Untrusted pagination Link origin')
		}
		if (seenPageUrls.has(nextUrl.href)) {
			throw new Error('Pagination Link cycle detected')
		}
		seenPageUrls.add(nextUrl.href)
		// Forward the server pagination URL verbatim so escaped markers (`%25`, `%23`) stay intact.
		currentUrl = nextUrl.href
	}

	return contents
}

/**
 * Fetches an atomic `{ etag, size, mtime }` snapshot for a single remote path
 * using `PROPFIND Depth: 0`. Preferred over `HEAD`, whose `200` response on
 * Nutstore omits `ETag` and reports `Content-Length: 0`.
 */
export async function statRemotePath(
	settings: NutstoreSettings,
	token: string,
	path: string,
	throwIfCancelled?: () => void,
	onRetry?: () => void,
): Promise<RemoteStatResult> {
	const davEndpoint = getNutstoreDavEndpoint(settings)
	const serverBase = new URL(davEndpoint).pathname
	const canonicalTarget = normalizeCanonicalPath(path)
	const url = `${davEndpoint}${encodeDavPath(canonicalTarget)}`

	try {
		const response = await retryWith503Backoff(
			() =>
				apiLimiter.schedule(async () => {
					throwIfCancelled?.()
					return await requestUrl({
						url,
						method: 'PROPFIND',
						headers: {
							Authorization: `Basic ${token}`,
							'Content-Type': 'application/xml',
							Depth: '0',
						},
						body: PROPFIND_REQUEST_BODY,
					})
				}),
			{ throwIfCancelled, onRetry: onRetry ? () => onRetry() : undefined },
		)
		throwIfCancelled?.()
		const { items: entries, unreadable } = parsePropfindXmlDetailed(
			response.text,
			serverBase,
		)
		const matched =
			entries.find(
				(entry) => normalizeCanonicalPath(entry.filename) === canonicalTarget,
			) ?? entries[0]
		if (!matched) {
			const failed =
				unreadable.find(
					(entry) => normalizeCanonicalPath(entry.path) === canonicalTarget,
				) ?? unreadable[0]
			if (failed && (!failed.status || !/\b404\b/.test(failed.status))) {
				return { status: 'unreadable', statusText: failed.status }
			}
			return { status: 'not-found' }
		}
		return {
			status: 'ok',
			stat: fileStatToStatModel({
				...matched,
				filename: canonicalTarget,
				basename: basename(canonicalTarget) || matched.basename,
			}),
		}
	} catch (error) {
		if (error instanceof RequestUrlError && error.res.status === 404) {
			return { status: 'not-found' }
		}
		throw error
	}
}
