import { createHash } from 'node:crypto'
import { decode as decodeHtmlEntities } from 'html-entities'
import type { RequestUrlParam, RequestUrlResponse } from 'obsidian'
import { basename, dirname, normalize } from 'path-browserify'
import type { BufferLike, FileStat, WebDAVClient } from 'webdav'
import { RequestUrlError } from '~/utils/request-url-error'
import { createMemoryClock, type MemoryClock } from './memory-vault'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8')

export interface WebDAVOp {
	op:
		| 'exists'
		| 'stat'
		| 'list'
		| 'get'
		| 'put'
		| 'mkdir'
		| 'delete'
		| 'move'
		| 'copy'
		| 'rangeGet'
		| 'propfind'
		| 'delta'
		| 'latestDeltaCursor'
	path: string
	dest?: string
	mutating: boolean
}

export type MoveSupportMode = 'supported' | 405 | 501

export interface WebDAVFaultRule {
	op?: WebDAVOp['op']
	pathPattern?: RegExp
	onCall?: number
	error: Error | { status: number; message?: string }
}

type RemoteNode =
	| {
			kind: 'file'
			bytes: Uint8Array
			mtimeMs: number
			etag: string
			version: number
	  }
	| { kind: 'dir'; mtimeMs: number }

interface DeltaLogEntry {
	revision: number
	path: string
	isDir: boolean
	isDeleted: boolean
	size: number
	modified: string
}

export function computeContentEtag(bytes: Uint8Array): string {
	return createHash('sha256')
		.update(bytes)
		.digest()
		.subarray(0, 16)
		.toString('base64url')
}

const escapeXml = (s: string) =>
	s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')

const normalizeRemote = (input: string): string => {
	const norm = normalize(input.startsWith('/') ? input : `/${input}`).replace(
		/\\/g,
		'/',
	)
	return norm.length > 1 && norm.endsWith('/') ? norm.slice(0, -1) : norm || '/'
}

const toBytes = (data: string | BufferLike | Uint8Array): Uint8Array =>
	typeof data === 'string'
		? encoder.encode(data)
		: data instanceof Uint8Array
			? new Uint8Array(data)
			: data instanceof ArrayBuffer
				? new Uint8Array(data.slice(0))
				: new Uint8Array(data as unknown as ArrayBufferLike)

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
	const copy = new ArrayBuffer(bytes.byteLength)
	new Uint8Array(copy).set(bytes)
	return copy
}

const truncateSec = (ms: number) => Math.floor(ms / 1000) * 1000

function getHeader(
	headers: Record<string, string> | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined
	const target = name.toLowerCase()
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === target) return v
	}
	return undefined
}

function httpError(status: number, message?: string): Error {
	const err = new RequestUrlError({
		status,
		headers: {},
		text: message ?? `HTTP ${status}`,
		arrayBuffer: new ArrayBuffer(0),
		json: null,
	} as unknown as RequestUrlResponse)
	return Object.assign(err, { status, response: { status } })
}

function xmlResponse(
	text: string,
	status = 200,
	extraHeaders: Record<string, string> = {},
): RequestUrlResponse {
	return {
		status,
		headers: {
			...(status < 300
				? { 'content-type': 'application/xml; charset=utf-8' }
				: {}),
			...extraHeaders,
		},
		text,
		arrayBuffer: toArrayBuffer(encoder.encode(text)),
		json: null,
	} as unknown as RequestUrlResponse
}

function notFoundXml(): string {
	return '<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:" xmlns:s="http://ns.jianguoyun.com"><s:exception>ObjectNotFound</s:exception><s:message>The object does not exist</s:message></d:error>'
}

function preconditionFailedXml(): string {
	return '<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:" xmlns:s="http://ns.jianguoyun.com"><s:exception>PreconditionFailed</s:exception><s:message>ETag doesn\'t match</s:message></d:error>'
}

/**
 * In-memory WebDAV + Nutstore Delta server shared by sync unit and DST tests.
 * Mirrors live Nutstore contract details: content-addressed unquoted ETags,
 * ETag preservation across MOVE, conditional `If-Match` / `If-Range`, and
 * `PROPFIND` `Depth: 0` / `Depth: 1` `<getetag>` behavior.
 */
export class MemoryWebDAV {
	readonly clock: MemoryClock
	readonly clockSkewMs: number
	readonly nodes = new Map<string, RemoteNode>()
	readonly ops: WebDAVOp[] = []
	readonly client: WebDAVClient
	moveSupport: MoveSupportMode
	deltaModifiedOffsetMs: number
	maxDeltaPageSize?: number
	forceDeltaResetOnNextCall = false
	injectStalledCursorOnNextCall = false
	onAfterOp?: (op: WebDAVOp) => void
	private revision = 0
	private readonly deltaLog: DeltaLogEntry[] = []
	private readonly faults: Array<{ rule: WebDAVFaultRule; hits: number }> = []

	constructor(options?: {
		clock?: MemoryClock
		clockSkewMs?: number
		moveSupport?: MoveSupportMode
		deltaModifiedOffsetMs?: number
		maxDeltaPageSize?: number
	}) {
		this.clock = options?.clock ?? createMemoryClock()
		this.clockSkewMs = options?.clockSkewMs ?? 0
		this.moveSupport = options?.moveSupport ?? 'supported'
		this.deltaModifiedOffsetMs = options?.deltaModifiedOffsetMs ?? 0
		this.maxDeltaPageSize = options?.maxDeltaPageSize
		this.nodes.set('/', { kind: 'dir', mtimeMs: this.nowMs() })
		this.client = this.buildClient()
	}

	private nowMs(): number {
		return truncateSec(this.clock.now() + this.clockSkewMs)
	}

	addFault(rule: WebDAVFaultRule): void {
		this.faults.push({ rule, hits: 0 })
	}

	clearFaults(): void {
		this.faults.length = 0
	}

	clearOps(): void {
		this.ops.length = 0
	}

	get mutatingOps(): WebDAVOp[] {
		return this.ops.filter((op) => op.mutating)
	}

	private record(op: WebDAVOp): void {
		this.ops.push(op)
		for (const entry of this.faults) {
			const { rule } = entry
			if (rule.op && rule.op !== op.op) continue
			if (rule.pathPattern && !rule.pathPattern.test(op.path)) continue
			entry.hits += 1
			if (rule.onCall !== undefined && entry.hits !== rule.onCall) continue
			throw rule.error instanceof Error
				? rule.error
				: httpError(rule.error.status, rule.error.message)
		}
	}

	private logDelta(
		path: string,
		isDir: boolean,
		isDeleted: boolean,
		size: number,
		mtimeMs: number,
	): void {
		this.revision += 1
		const serverModifiedMs = truncateSec(mtimeMs + this.deltaModifiedOffsetMs)
		this.deltaLog.push({
			revision: this.revision,
			path,
			isDir,
			isDeleted,
			size,
			modified: new Date(serverModifiedMs).toUTCString(),
		})
	}

	private ensureParents(absPath: string, mtimeMs: number): void {
		const parts = absPath.split('/').filter(Boolean)
		parts.pop()
		let cur = ''
		for (const part of parts) {
			cur = `${cur}/${part}`
			const existing = this.nodes.get(cur)
			if (existing?.kind === 'file') {
				throw httpError(409, `Parent is a file: ${cur}`)
			}
			if (!existing) {
				this.nodes.set(cur, { kind: 'dir', mtimeMs })
				this.logDelta(cur, true, false, 0, mtimeMs)
			}
		}
	}

	seedDir(remotePath: string, mtimeMs?: number): void {
		const abs = normalizeRemote(remotePath)
		if (abs === '/') return
		const ts = truncateSec(mtimeMs ?? this.nowMs())
		this.ensureParents(abs, ts)
		const existing = this.nodes.get(abs)
		if (existing?.kind === 'file') {
			throw new Error(`Cannot seed remote dir over file: ${abs}`)
		}
		if (!existing) {
			this.nodes.set(abs, { kind: 'dir', mtimeMs: ts })
			this.logDelta(abs, true, false, 0, ts)
		}
	}

	seedFile(
		remotePath: string,
		content: string | Uint8Array | ArrayBuffer,
		mtimeMs?: number,
	): void {
		const abs = normalizeRemote(remotePath)
		if (abs === '/') throw new Error('Cannot seed remote file at /')
		const ts = truncateSec(mtimeMs ?? this.nowMs())
		this.ensureParents(abs, ts)
		const existing = this.nodes.get(abs)
		if (existing?.kind === 'dir') {
			throw new Error(`Cannot seed remote file over dir: ${abs}`)
		}
		const bytes = toBytes(content)
		this.nodes.set(abs, {
			kind: 'file',
			bytes,
			mtimeMs: ts,
			etag: computeContentEtag(bytes),
			version: existing?.kind === 'file' ? existing.version + 1 : 1,
		})
		this.logDelta(abs, false, false, bytes.byteLength, ts)
	}

	deleteDirect(remotePath: string): void {
		const abs = normalizeRemote(remotePath)
		const node = this.nodes.get(abs)
		if (!node || abs === '/') return
		const ts = this.nowMs()
		if (node.kind === 'dir') {
			const prefix = `${abs}/`
			for (const [k, child] of [...this.nodes.entries()]) {
				if (k.startsWith(prefix)) {
					this.nodes.delete(k)
					this.logDelta(k, child.kind === 'dir', true, 0, ts)
				}
			}
		}
		this.nodes.delete(abs)
		this.logDelta(abs, node.kind === 'dir', true, 0, ts)
	}

	snapshotFiles(remoteBaseDir: string): Map<string, Uint8Array> {
		const base = normalizeRemote(remoteBaseDir)
		const prefix = base === '/' ? '/' : `${base}/`
		const out = new Map<string, Uint8Array>()
		for (const [p, n] of this.nodes) {
			if (n.kind === 'file' && p.startsWith(prefix)) {
				const rel = p.slice(prefix.length)
				if (rel) out.set(rel, new Uint8Array(n.bytes))
			}
		}
		return out
	}

	readBytesDirect(remotePath: string): Uint8Array | undefined {
		const node = this.nodes.get(normalizeRemote(remotePath))
		return node?.kind === 'file' ? new Uint8Array(node.bytes) : undefined
	}

	private toFileStat(abs: string, node: RemoteNode): FileStat {
		return {
			filename: abs,
			basename: basename(abs),
			lastmod: new Date(node.mtimeMs).toUTCString(),
			size: node.kind === 'file' ? node.bytes.byteLength : 0,
			type: node.kind === 'dir' ? 'directory' : 'file',
			etag: node.kind === 'file' ? node.etag : null,
			mime: node.kind === 'file' ? 'application/octet-stream' : undefined,
		}
	}

	private listChildren(dirPath: string): Array<[string, RemoteNode]> {
		const abs = normalizeRemote(dirPath)
		const prefix = abs === '/' ? '/' : `${abs}/`
		return [...this.nodes.entries()]
			.filter(([p]) => {
				if (p === abs || !p.startsWith(prefix)) return false
				const rest = p.slice(prefix.length)
				return Boolean(rest) && !rest.includes('/')
			})
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	}

	private renderPropfindXml(
		abs: string,
		node: RemoteNode,
		serverBase: string,
		depth: string,
		body: string,
	): string {
		const base = serverBase === '/' ? '' : serverBase.replace(/\/+$/, '')
		const includeEtag =
			!body ||
			/<(?:\w+:)?allprop\b/i.test(body) ||
			/<(?:\w+:)?resourcetype\b/i.test(body) ||
			/<(?:\w+:)?getcontenttype\b/i.test(body)
		const render = (p: string, item: RemoteNode) => {
			const encoded = p
				.split('/')
				.filter(Boolean)
				.map(encodeURIComponent)
				.join('/')
			const href = encoded ? `${base}/${encoded}` : `${base}/`
			const etagTag = !includeEtag
				? ''
				: item.kind === 'dir'
					? '<D:getetag/>'
					: `<D:getetag>${escapeXml(item.etag)}</D:getetag>`
			const sizeAndType =
				item.kind === 'file'
					? `<D:getcontentlength>${item.bytes.byteLength}</D:getcontentlength><D:getcontenttype>application/octet-stream</D:getcontenttype>`
					: ''
			return `<D:response><D:href>${escapeXml(href)}</D:href><D:propstat><D:prop><D:displayname>${escapeXml(basename(p) || '')}</D:displayname><D:resourcetype>${item.kind === 'dir' ? '<D:collection/>' : ''}</D:resourcetype><D:getlastmodified>${escapeXml(new Date(item.mtimeMs).toUTCString())}</D:getlastmodified>${sizeAndType}${etagTag}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
		}
		const items = [
			render(abs, node),
			...(depth !== '0' && node.kind === 'dir'
				? this.listChildren(abs).map(([p, c]) => render(p, c))
				: []),
		]
		return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${items.join('')}</D:multistatus>`
	}

	async handleRequestUrl(
		request: RequestUrlParam | string,
	): Promise<RequestUrlResponse> {
		const param: RequestUrlParam =
			typeof request === 'string' ? { url: request } : request
		const method = (param.method ?? 'GET').toUpperCase()
		const url = new URL(param.url)

		if (method === 'PROPFIND') {
			const idx = url.pathname.indexOf('/dav')
			const serverBase = idx >= 0 ? url.pathname.slice(0, idx + 4) : '/'
			const subPath = idx >= 0 ? url.pathname.slice(idx + 4) : url.pathname
			const abs = normalizeRemote(
				subPath
					.split('/')
					.map((seg) => decodeURIComponent(seg))
					.join('/') || '/',
			)
			this.record({ op: 'propfind', path: abs, mutating: false })
			const node = this.nodes.get(abs)
			if (!node) return xmlResponse(notFoundXml(), 404)
			const depth = getHeader(param.headers, 'depth') ?? '1'
			const body = typeof param.body === 'string' ? param.body : ''
			return xmlResponse(
				this.renderPropfindXml(abs, node, serverBase, depth, body),
				207,
			)
		}

		if (method === 'HEAD') {
			const idx = url.pathname.indexOf('/dav')
			const subPath = idx >= 0 ? url.pathname.slice(idx + 4) : url.pathname
			const abs = normalizeRemote(
				subPath
					.split('/')
					.map((seg) => decodeURIComponent(seg))
					.join('/') || '/',
			)
			this.record({ op: 'stat', path: abs, mutating: false })
			const node = this.nodes.get(abs)
			if (!node) return xmlResponse(notFoundXml(), 404)
			const inm = getHeader(param.headers, 'if-none-match')
			if (node.kind === 'file' && inm && inm === node.etag) {
				return xmlResponse('', 304, {
					'last-modified': new Date(node.mtimeMs).toUTCString(),
				})
			}
			// Mirror live Nutstore: HEAD 200 omits ETag and reports Content-Length 0.
			return xmlResponse('', 200, {
				'last-modified': new Date(node.mtimeMs).toUTCString(),
				'content-length': '0',
			})
		}

		if (method === 'POST' && url.pathname.endsWith('/latestDeltaCursor')) {
			this.record({
				op: 'latestDeltaCursor',
				path: url.pathname,
				mutating: false,
			})
			return xmlResponse(
				`<?xml version="1.0" encoding="utf-8"?><response><cursor>${this.revision}</cursor></response>`,
			)
		}

		if (method === 'POST' && url.pathname.endsWith('/delta')) {
			const body = typeof param.body === 'string' ? param.body : ''
			const folder = decodeHtmlEntities(
				/<s:folderName>([\s\S]*?)<\/s:folderName>/.exec(body)?.[1]?.trim() ??
					'',
				{ level: 'xml' },
			)
			const cursor =
				Number.parseInt(
					/<s:cursor>([\s\S]*?)<\/s:cursor>/.exec(body)?.[1]?.trim() ?? '0',
					10,
				) || 0
			this.record({ op: 'delta', path: `/${folder}`, mutating: false })
			if (this.forceDeltaResetOnNextCall) {
				this.forceDeltaResetOnNextCall = false
				return xmlResponse(
					'<?xml version="1.0" encoding="utf-8"?><response><reset>true</reset></response>',
				)
			}
			if (this.injectStalledCursorOnNextCall) {
				this.injectStalledCursorOnNextCall = false
				return xmlResponse(
					`<?xml version="1.0" encoding="utf-8"?><response><reset>false</reset><cursor>${cursor}</cursor><hasMore>true</hasMore></response>`,
				)
			}
			const prefix = folder ? `/${folder}` : '/'
			const matching = this.deltaLog.filter(
				(e) =>
					e.revision > cursor &&
					(e.path === prefix || e.path.startsWith(`${prefix}/`)),
			)
			const pageLimit = this.maxDeltaPageSize
			const hasMore = pageLimit !== undefined && matching.length > pageLimit
			const pageEntries = hasMore ? matching.slice(0, pageLimit) : matching
			const nextCursor = hasMore
				? pageEntries[pageEntries.length - 1].revision
				: this.revision
			const entriesXml = pageEntries
				.map(
					(e) =>
						`<entry><path>${escapeXml(e.path)}</path><size>${e.size}</size><isDeleted>${e.isDeleted}</isDeleted><isDir>${e.isDir}</isDir><modified>${escapeXml(e.modified)}</modified><revision>${e.revision}</revision></entry>`,
				)
				.join('')
			return xmlResponse(
				`<?xml version="1.0" encoding="utf-8"?><response><reset>false</reset><cursor>${nextCursor}</cursor><hasMore>${hasMore}</hasMore>${entriesXml ? `<delta>${entriesXml}</delta>` : ''}</response>`,
			)
		}

		return xmlResponse(`Unhandled request: ${method} ${param.url}`, 404)
	}

	private buildClient(): WebDAVClient {
		const client: Partial<WebDAVClient> = {
			exists: async (filename: string) => {
				const abs = normalizeRemote(filename)
				this.record({ op: 'exists', path: abs, mutating: false })
				return this.nodes.has(abs)
			},
			stat: async (filename: string) => {
				const abs = normalizeRemote(filename)
				this.record({ op: 'stat', path: abs, mutating: false })
				const node = this.nodes.get(abs)
				if (!node) throw httpError(404, `Not found: ${abs}`)
				return this.toFileStat(abs, node)
			},
			getDirectoryContents: (async (filename: string) => {
				const abs = normalizeRemote(filename)
				this.record({ op: 'list', path: abs, mutating: false })
				const node = this.nodes.get(abs)
				if (!node) throw httpError(404, `Not found: ${abs}`)
				if (node.kind !== 'dir') throw httpError(400, `Not a directory: ${abs}`)
				return this.listChildren(abs).map(([p, c]) => this.toFileStat(p, c))
			}) as WebDAVClient['getDirectoryContents'],
			getFileContents: async (filename: string, options) => {
				const abs = normalizeRemote(filename)
				this.record({ op: 'get', path: abs, mutating: false })
				const node = this.nodes.get(abs)
				if (!node) throw httpError(404, `Not found: ${abs}`)
				if (node.kind !== 'file') throw httpError(400, `Not a file: ${abs}`)
				return options?.format === 'text'
					? decoder.decode(node.bytes)
					: toArrayBuffer(node.bytes)
			},
			putFileContents: async (filename: string, data, options) => {
				const abs = normalizeRemote(filename)
				this.record({ op: 'put', path: abs, mutating: true })
				const parent = normalizeRemote(dirname(abs))
				if (this.nodes.get(parent)?.kind !== 'dir') {
					throw httpError(409, `Parent directory missing: ${parent}`)
				}
				const existing = this.nodes.get(abs)
				if (existing && options?.overwrite === false) {
					throw httpError(412, `File already exists: ${abs}`)
				}
				if (existing?.kind === 'dir') {
					throw httpError(409, `Cannot overwrite directory with file: ${abs}`)
				}
				const bytes = toBytes(data as string | BufferLike)
				const ts = this.nowMs()
				this.nodes.set(abs, {
					kind: 'file',
					bytes,
					mtimeMs: ts,
					etag: computeContentEtag(bytes),
					version: existing?.kind === 'file' ? existing.version + 1 : 1,
				})
				this.logDelta(abs, false, false, bytes.byteLength, ts)
				return true
			},
			createDirectory: async (path: string, options) => {
				const abs = normalizeRemote(path)
				this.record({ op: 'mkdir', path: abs, mutating: true })
				if (abs === '/') return
				const ts = this.nowMs()
				if (options?.recursive) this.ensureParents(abs, ts)
				else if (
					this.nodes.get(normalizeRemote(dirname(abs)))?.kind !== 'dir'
				) {
					throw httpError(409, `Parent missing: ${dirname(abs)}`)
				}
				const existing = this.nodes.get(abs)
				if (existing?.kind === 'file') {
					throw httpError(405, `File exists at directory path: ${abs}`)
				}
				if (!existing) {
					this.nodes.set(abs, { kind: 'dir', mtimeMs: ts })
					this.logDelta(abs, true, false, 0, ts)
				}
			},
			deleteFile: async (filename: string) => {
				const abs = normalizeRemote(filename)
				this.record({ op: 'delete', path: abs, mutating: true })
				if (!this.nodes.has(abs)) throw httpError(404, `Not found: ${abs}`)
				if (abs === '/') throw httpError(403, 'Cannot delete root')
				this.deleteDirect(abs)
			},
			moveFile: async (filename: string, dest: string, options) => {
				const from = normalizeRemote(filename)
				const to = normalizeRemote(dest)
				this.record({ op: 'move', path: from, dest: to, mutating: true })
				if (this.moveSupport !== 'supported') {
					throw httpError(
						this.moveSupport,
						`Invalid response: ${this.moveSupport} Method Not Allowed`,
					)
				}
				const node = this.nodes.get(from)
				if (!node) throw httpError(404, `Source not found: ${from}`)
				if (this.nodes.get(normalizeRemote(dirname(to)))?.kind !== 'dir') {
					throw httpError(409, `Destination parent missing: ${dirname(to)}`)
				}
				const existingDest = this.nodes.get(to)
				if (existingDest && options?.overwrite === false) {
					throw httpError(412, `Destination exists: ${to}`)
				}
				const ts = this.nowMs()
				if (existingDest) this.deleteDirect(to)
				const prefix = `${from}/`
				const moved: Array<[string, RemoteNode]> =
					node.kind === 'file'
						? [
								[
									from,
									{
										...node,
										bytes: new Uint8Array(node.bytes),
									},
								],
							]
						: [
								[from, node],
								...[...this.nodes.entries()].filter(([k]) =>
									k.startsWith(prefix),
								),
							]
				for (const [k, v] of moved) {
					this.nodes.delete(k)
					this.logDelta(k, v.kind === 'dir', true, 0, ts)
				}
				for (const [k, v] of moved) {
					const next = k === from ? to : `${to}${k.slice(from.length)}`
					this.nodes.set(next, v)
					this.logDelta(
						next,
						v.kind === 'dir',
						false,
						v.kind === 'file' ? v.bytes.byteLength : 0,
						v.mtimeMs,
					)
				}
			},
			copyFile: async (filename: string, dest: string) => {
				const from = normalizeRemote(filename)
				const to = normalizeRemote(dest)
				this.record({ op: 'copy', path: from, dest: to, mutating: true })
				const node = this.nodes.get(from)
				if (!node || node.kind !== 'file') {
					throw httpError(404, `Source not found: ${from}`)
				}
				await client.putFileContents!(to, toArrayBuffer(node.bytes), {
					overwrite: true,
				})
			},
			customRequest: async (path: string, requestOptions) => {
				const abs = normalizeRemote(path)
				const method = (requestOptions?.method ?? 'GET').toUpperCase()
				const headers = (requestOptions?.headers ?? {}) as Record<
					string,
					string
				>

				if (method === 'PROPFIND') {
					this.record({ op: 'propfind', path: abs, mutating: false })
					const node = this.nodes.get(abs)
					if (!node) throw httpError(404, notFoundXml())
					const depth = getHeader(headers, 'depth') ?? '1'
					const body =
						typeof requestOptions?.data === 'string' ? requestOptions.data : ''
					return new Response(
						this.renderPropfindXml(abs, node, '/dav', depth, body),
						{
							status: 207,
							headers: { 'content-type': 'application/xml; charset=utf-8' },
						},
					) as never
				}

				if (method === 'PUT') {
					const op: WebDAVOp = { op: 'put', path: abs, mutating: true }
					this.record(op)
					const parent = normalizeRemote(dirname(abs))
					if (this.nodes.get(parent)?.kind !== 'dir') {
						throw httpError(409, `Parent directory missing: ${parent}`)
					}
					const existing = this.nodes.get(abs)
					const ifMatch = getHeader(headers, 'if-match')
					if (ifMatch) {
						if (!existing) {
							throw httpError(409, notFoundXml())
						}
						if (existing.kind === 'file' && ifMatch !== existing.etag) {
							throw httpError(412, preconditionFailedXml())
						}
					}
					if (existing?.kind === 'dir') {
						throw httpError(409, `Cannot overwrite directory with file: ${abs}`)
					}
					const bytes = toBytes(requestOptions?.data as string | BufferLike)
					const ts = this.nowMs()
					const nextVersion =
						existing?.kind === 'file' ? existing.version + 1 : 1
					this.nodes.set(abs, {
						kind: 'file',
						bytes,
						mtimeMs: ts,
						etag: computeContentEtag(bytes),
						version: nextVersion,
					})
					this.logDelta(abs, false, false, bytes.byteLength, ts)
					const res = new Response(null, {
						status: existing ? 204 : 201,
						headers: { 'x-file-version': String(nextVersion) },
					}) as never
					this.onAfterOp?.(op)
					return res
				}

				const rangeHeader = getHeader(headers, 'range')
				const op: WebDAVOp = {
					op: rangeHeader ? 'rangeGet' : 'get',
					path: abs,
					mutating: false,
				}
				this.record(op)
				const node = this.nodes.get(abs)
				if (!node) {
					throw httpError(404, notFoundXml())
				}
				if (node.kind !== 'file') {
					throw httpError(403, 'Can not download collection')
				}
				const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader ?? '')
				const ifRange = getHeader(headers, 'if-range')
				if (match && (!ifRange || ifRange === node.etag)) {
					const start = Number(match[1])
					const end = Math.min(Number(match[2]), node.bytes.byteLength - 1)
					const res = new Response(
						toArrayBuffer(node.bytes.slice(start, end + 1)),
						{
							status: 206,
							headers: {
								'content-range': `bytes ${start}-${end}/${node.bytes.byteLength}`,
								etag: node.etag,
								'last-modified': new Date(node.mtimeMs).toUTCString(),
							},
						},
					) as never
					this.onAfterOp?.(op)
					return res
				}
				const res = new Response(toArrayBuffer(node.bytes), {
					status: 200,
					headers: {
						etag: node.etag,
						'last-modified': new Date(node.mtimeMs).toUTCString(),
						'content-length': String(node.bytes.byteLength),
					},
				}) as never
				this.onAfterOp?.(op)
				return res
			},
		}
		return client as WebDAVClient
	}
}
