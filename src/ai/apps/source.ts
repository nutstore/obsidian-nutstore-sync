import { posix as pathPosix } from 'path-browserify'
import { bytesToDataUrl } from '~/utils/data-url'
import type { AppContent } from './domain'

/**
 * Source references that cannot be resolved are a hard error: the sandbox has
 * no network and cannot load another origin. The message names the offending
 * file so the authoring agent can fix it without guessing.
 */
export class AppSourceError extends Error {
	constructor(
		readonly path: string,
		message: string,
		options?: ErrorOptions,
	) {
		super(`${path}: ${message}`, options)
		this.name = 'AppSourceError'
	}
}

export interface AppSourceReader {
	readText(path: string): Promise<string>
	readBinary(path: string): Promise<ArrayBuffer>
}

const JS_MEDIA_TYPES = [
	'',
	'text/javascript',
	'application/javascript',
	'text/ecmascript',
	'application/ecmascript',
]

const MEDIA_TYPES: Record<string, string> = {
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.m4a': 'audio/mp4',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
}

const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

function mediaTypeFor(path: string) {
	const extension = pathPosix.extname(path).toLowerCase()
	const mediaType = MEDIA_TYPES[extension]
	if (!mediaType)
		throw new AppSourceError(path, 'Unsupported App asset type for inlining')
	return mediaType
}

/**
 * Resolve one authored reference against the file that contains it.
 * Returns undefined for references that stay untouched (fragments, data URLs);
 * throws for references that cannot exist inside a self-contained App.
 */
function referencePath(raw: string, fromPath: string): string | undefined {
	const value = raw.trim()
	if (!value || value.startsWith('#')) return undefined
	if (/^data:/i.test(value)) return undefined
	if (value.startsWith('//'))
		throw new AppSourceError(
			fromPath,
			`Protocol-relative URL is not supported in an App: '${value}'`,
		)
	if (SCHEME_PATTERN.test(value))
		throw new AppSourceError(
			fromPath,
			`Remote URL is not supported in an App: '${value}'`,
		)
	const reference = value.split(/[?#]/, 1)[0] ?? ''
	if (!reference) return undefined
	if (reference.startsWith('/'))
		throw new AppSourceError(
			fromPath,
			`Absolute path is not supported in an App: '${value}'`,
		)
	if (reference.includes('\\') || reference.includes('\0'))
		throw new AppSourceError(
			fromPath,
			`Invalid path in App reference: '${value}'`,
		)
	const resolved = pathPosix.normalize(
		pathPosix.join(pathPosix.dirname(fromPath), reference),
	)
	if (
		resolved === '.' ||
		resolved === '..' ||
		resolved === '/' ||
		resolved.startsWith('../') ||
		pathPosix.isAbsolute(resolved)
	)
		throw new AppSourceError(
			fromPath,
			`Reference escapes the App directory: '${value}'`,
		)
	if (resolved.endsWith('/'))
		throw new AppSourceError(
			fromPath,
			`Reference must name a file, not a directory: '${value}'`,
		)
	return resolved
}

async function readText(reader: AppSourceReader, path: string) {
	try {
		return await reader.readText(path)
	} catch (error) {
		throw new AppSourceError(
			path,
			`Cannot read App file: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		)
	}
}

async function readBinary(reader: AppSourceReader, path: string) {
	try {
		return await reader.readBinary(path)
	} catch (error) {
		throw new AppSourceError(
			path,
			`Cannot read App asset: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		)
	}
}

interface CssToken {
	kind: 'url' | 'import'
	start: number
	end: number
	raw: string
}

function isIdentChar(value: string | undefined) {
	return !!value && /[a-zA-Z0-9_-]/.test(value)
}

function readCssString(css: string, start: number, fromPath: string) {
	const quote = css[start]
	let index = start + 1
	let value = ''
	while (index < css.length) {
		const char = css[index]
		if (char === '\\') {
			value += css[index + 1] ?? ''
			index += 2
			continue
		}
		if (char === quote) return { value, end: index + 1 }
		value += char
		index++
	}
	throw new AppSourceError(fromPath, 'Unterminated string in App stylesheet')
}

function skipWhitespace(css: string, start: number) {
	let index = start
	while (index < css.length && /\s/.test(css[index])) index++
	return index
}

function parseUrlToken(css: string, start: number, fromPath: string): CssToken {
	let index = start + 4
	index = skipWhitespace(css, index)
	let raw: string
	if (css[index] === '"' || css[index] === "'") {
		const string = readCssString(css, index, fromPath)
		raw = string.value
		index = string.end
	} else {
		const valueStart = index
		while (index < css.length && css[index] !== ')') index++
		raw = css.slice(valueStart, index).trim()
	}
	index = skipWhitespace(css, index)
	if (css[index] !== ')')
		throw new AppSourceError(fromPath, 'Unterminated url() in App stylesheet')
	return { kind: 'url', start, end: index + 1, raw }
}

function parseImport(css: string, start: number, fromPath: string): CssToken {
	let index = skipWhitespace(css, start + 7)
	let raw: string
	if (css.slice(index, index + 4).toLowerCase() === 'url(') {
		const url = parseUrlToken(css, index, fromPath)
		raw = url.raw
		index = url.end
	} else if (css[index] === '"' || css[index] === "'") {
		const string = readCssString(css, index, fromPath)
		raw = string.value
		index = string.end
	} else {
		throw new AppSourceError(fromPath, 'Invalid CSS @import in App stylesheet')
	}
	index = skipWhitespace(css, index)
	if (css[index] !== ';')
		throw new AppSourceError(
			fromPath,
			'CSS @import with media conditions is not supported in App stylesheets',
		)
	return { kind: 'import', start, end: index + 1, raw }
}

function scanCss(css: string, fromPath: string): CssToken[] {
	const tokens: CssToken[] = []
	let index = 0
	while (index < css.length) {
		const char = css[index]
		if (char === '/' && css[index + 1] === '*') {
			const end = css.indexOf('*/', index + 2)
			index = end < 0 ? css.length : end + 2
			continue
		}
		if (char === '"' || char === "'") {
			index = readCssString(css, index, fromPath).end
			continue
		}
		if (
			char === '@' &&
			css.slice(index, index + 7).toLowerCase() === '@import' &&
			!isIdentChar(css[index + 7])
		) {
			const token = parseImport(css, index, fromPath)
			tokens.push(token)
			index = token.end
			continue
		}
		if (
			(char === 'u' || char === 'U') &&
			css.slice(index, index + 4).toLowerCase() === 'url(' &&
			!isIdentChar(css[index - 1])
		) {
			const token = parseUrlToken(css, index, fromPath)
			tokens.push(token)
			index = token.end
			continue
		}
		index++
	}
	return tokens
}

async function processCss(
	css: string,
	fromPath: string,
	ancestors: ReadonlySet<string>,
	reader: AppSourceReader,
	readAssetUrl: (path: string) => Promise<string>,
): Promise<string> {
	const tokens = scanCss(css, fromPath)
	if (!tokens.length) return css
	let result = ''
	let cursor = 0
	for (const token of tokens) {
		result += css.slice(cursor, token.start)
		cursor = token.end
		const resolved = referencePath(token.raw, fromPath)
		if (token.kind === 'import') {
			if (!resolved)
				throw new AppSourceError(
					fromPath,
					`CSS @import must reference an App file: '${token.raw}'`,
				)
			if (ancestors.has(resolved))
				throw new AppSourceError(
					resolved,
					`Circular CSS @import: ${[...ancestors, resolved].join(' -> ')}`,
				)
			const imported = await readText(reader, resolved)
			const processed = await processCss(
				imported,
				resolved,
				new Set([...ancestors, resolved]),
				reader,
				readAssetUrl,
			)
			result += `\n${processed}\n`
			continue
		}
		if (!resolved) {
			result += css.slice(token.start, token.end)
			continue
		}
		result += `url("${await readAssetUrl(resolved)}")`
	}
	return result + css.slice(cursor)
}

function assertScriptType(script: Element, fromPath: string) {
	const type = script.getAttribute('type')?.trim().toLowerCase()
	if (type === undefined) return
	if (type === 'module')
		throw new AppSourceError(
			fromPath,
			'ES module scripts are not supported in Apps; use a classic script',
		)
	if (!JS_MEDIA_TYPES.includes(type))
		throw new AppSourceError(
			fromPath,
			`Unsupported script type in App: '${type}'`,
		)
}

/**
 * Turn the authored file tree into the single self-contained document the
 * sandbox receives. The sandbox has an opaque origin, no network and
 * `default-src 'none'`, so relative references only work by being read here and
 * inlined: CSS/JS as text, images/fonts/media as data URLs.
 */
export async function assembleAppContent(input: {
	html: string
	reader: AppSourceReader
}): Promise<AppContent> {
	const { reader } = input
	// Share encoded assets across CSS and markup only for this file snapshot.
	const assetUrls = new Map<string, Promise<string>>()
	const readAssetUrl = (path: string): Promise<string> => {
		let url = assetUrls.get(path)
		if (!url) {
			url = readBinary(reader, path).then((bytes) =>
				bytesToDataUrl(mediaTypeFor(path), bytes),
			)
			assetUrls.set(path, url)
		}
		return url
	}
	const doc = new DOMParser().parseFromString(input.html, 'text/html')
	const fromPath = 'index.html'
	if (doc.querySelector('base'))
		throw new AppSourceError(
			fromPath,
			'<base> is not supported in an App document',
		)
	const cssParts: string[] = []
	for (const element of Array.from(doc.querySelectorAll('style, link'))) {
		if (element.localName === 'style') {
			const css = element.textContent ?? ''
			cssParts.push(
				await processCss(
					css,
					fromPath,
					new Set<string>(),
					reader,
					readAssetUrl,
				),
			)
			element.remove()
			continue
		}
		const rel = (element.getAttribute('rel') ?? '').toLowerCase()
		const href = element.getAttribute('href')
		if (!rel.split(/\s+/).includes('stylesheet') || !href) {
			element.remove()
			continue
		}
		const resolved = referencePath(href, fromPath)
		if (!resolved)
			throw new AppSourceError(
				fromPath,
				`Stylesheet must reference an App file: '${href}'`,
			)
		const css = await readText(reader, resolved)
		cssParts.push(
			await processCss(
				css,
				resolved,
				new Set([resolved]),
				reader,
				readAssetUrl,
			),
		)
		element.remove()
	}
	const jsParts: string[] = []
	for (const script of Array.from(doc.querySelectorAll('script'))) {
		assertScriptType(script, fromPath)
		const src = script.getAttribute('src')
		if (src === null) {
			jsParts.push(script.textContent ?? '')
			script.remove()
			continue
		}
		const resolved = referencePath(src, fromPath)
		if (!resolved)
			throw new AppSourceError(
				fromPath,
				`Script must reference an App file: '${src}'`,
			)
		jsParts.push(await readText(reader, resolved))
		script.remove()
	}
	for (const element of Array.from(
		doc.querySelectorAll('img, source, audio, video, image'),
	)) {
		if (element.hasAttribute('srcset'))
			throw new AppSourceError(fromPath, 'srcset is not supported in Apps')
		const attributes =
			element.localName === 'image'
				? ['href', 'xlink:href']
				: element.localName === 'video'
					? ['src', 'poster']
					: ['src']
		for (const attribute of attributes) {
			const raw = element.getAttribute(attribute)
			if (raw === null) continue
			const resolved = referencePath(raw, fromPath)
			if (!resolved) continue
			element.setAttribute(attribute, await readAssetUrl(resolved))
		}
	}
	return {
		html: doc.body.innerHTML,
		css: cssParts.join('\n'),
		javascript: jsParts.join('\n;\n'),
	}
}
