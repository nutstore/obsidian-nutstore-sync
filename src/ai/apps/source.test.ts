// @vitest-environment jsdom
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
	AppSourceError,
	assembleAppContent,
	type AppSourceReader,
} from './source'

type FixtureFile = string | Uint8Array

const encoder = new TextEncoder()
function utf8(value: string) {
	// Copy into this realm's Uint8Array: the jsdom environment can hand back a
	// TextEncoder result from another realm, which breaks `instanceof`.
	return new Uint8Array(encoder.encode(value))
}
function dataUrl(mediaType: string, value: Uint8Array) {
	return `data:${mediaType};base64,${Buffer.from(value).toString('base64')}`
}
function reader(files: Record<string, FixtureFile>) {
	const reads: string[] = []
	const source: AppSourceReader = {
		readText: async (path) => {
			reads.push(`text:${path}`)
			const value = files[path]
			if (typeof value !== 'string')
				throw new Error(`missing text file: ${path}`)
			return value
		},
		readBinary: async (path) => {
			reads.push(`binary:${path}`)
			const value = files[path]
			if (!(value instanceof Uint8Array))
				throw new Error(`missing binary file: ${path}`)
			return value.buffer.slice(
				value.byteOffset,
				value.byteOffset + value.byteLength,
			) as ArrayBuffer
		},
	}
	return { source, files, reads }
}
function parse(html: string) {
	return new DOMParser().parseFromString(html, 'text/html')
}
async function sourceError(promise: Promise<unknown>) {
	try {
		await promise
	} catch (error) {
		expect(error).toBeInstanceOf(AppSourceError)
		return error as AppSourceError
	}
	throw new Error('Expected an AppSourceError')
}

describe('App source assembly', () => {
	it('inlines linked stylesheets and classic scripts while keeping multilingual text', async () => {
		const { source } = reader({
			'styles.css': '.card { color: green; }',
			'app.js': 'document.title = "中性应用 Neutral app 🌿"',
		})
		const result = await assembleAppContent({
			html: [
				'<!doctype html><html><head>',
				'<link rel="stylesheet" href="styles.css">',
				'</head><body>',
				'<main class="card">中性计数器 Neutral counter 🌿</main>',
				'<script src="app.js"></script>',
				'</body></html>',
			].join(''),
			reader: source,
		})

		expect(result.css).toBe('.card { color: green; }')
		expect(result.javascript).toBe('document.title = "中性应用 Neutral app 🌿"')
		const body = parse(result.html)
		expect(body.querySelector('main')?.textContent).toBe(
			'中性计数器 Neutral counter 🌿',
		)
		expect(body.querySelector('link')).toBeNull()
		expect(body.querySelector('script')).toBeNull()
		expect(result.html).not.toContain('<link')
	})

	it('collects CSS parts and JS parts in authored order with stable separators', async () => {
		const { source } = reader({
			'a.css': '.linked { color: green; }',
			'b.js': 'const linked = "连接 Linked 🌿"',
		})
		const result = await assembleAppContent({
			html: [
				'<style>.first { color: red; }</style>',
				'<link rel="stylesheet" href="a.css">',
				'<h1>标题 Title 🌿</h1>',
				'<script>const first = "第一 First 🌿"</script>',
				'<script src="b.js"></script>',
				'<script>const third = "第三 Third 🌿"</script>',
			].join(''),
			reader: source,
		})

		expect(result.css).toBe('.first { color: red; }\n.linked { color: green; }')
		expect(result.javascript).toBe(
			[
				'const first = "第一 First 🌿"',
				'const linked = "连接 Linked 🌿"',
				'const third = "第三 Third 🌿"',
			].join('\n;\n'),
		)
		expect(parse(result.html).querySelector('style')).toBeNull()
		expect(parse(result.html).querySelector('h1')?.textContent).toBe(
			'标题 Title 🌿',
		)
	})

	it('resolves references relative to the file that contains them', async () => {
		const background = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
		const icon = utf8('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
		const { source, reads } = reader({
			'styles/main.css': [
				'@import "./base/tokens.css";',
				'body { background: url("../assets/bg.png"); }',
			].join('\n'),
			'styles/base/tokens.css': ':root { --tone: green; }',
			'assets/bg.png': background,
			'assets/icon.svg': icon,
		})
		const result = await assembleAppContent({
			html: [
				'<link rel="stylesheet" href="styles/main.css">',
				'<img src="assets/icon.svg" alt="中性图标 Neutral icon 🌿">',
			].join(''),
			reader: source,
		})

		expect(result.css).toContain(':root { --tone: green; }')
		expect(result.css).toContain(`url("${dataUrl('image/png', background)}")`)
		expect(result.css.indexOf(':root')).toBeLessThan(
			result.css.indexOf('background'),
		)
		expect(parse(result.html).querySelector('img')?.getAttribute('src')).toBe(
			dataUrl('image/svg+xml', icon),
		)
		expect(reads).toEqual(
			expect.arrayContaining([
				'text:styles/main.css',
				'text:styles/base/tokens.css',
				'binary:assets/bg.png',
				'binary:assets/icon.svg',
			]),
		)
	})

	it('shares UTF-8 assets across CSS and markup but rereads them for each assembly', async () => {
		const assetPath = 'assets/中性图标 Neutral icon 🌿.svg'
		const initial = utf8(
			'<svg xmlns="http://www.w3.org/2000/svg"><title>中性图标 Neutral icon 🌿</title></svg>',
		)
		const updated = utf8(
			'<svg xmlns="http://www.w3.org/2000/svg"><title>更新图标 Updated icon 🍃</title></svg>',
		)
		const { source, files, reads } = reader({
			[assetPath]: initial,
			'styles/main.css': '@import "nested/theme.css";',
			'styles/nested/theme.css': `.icon { background: url("../../${assetPath}"); }`,
		})
		const input = {
			html: [
				'<link rel="stylesheet" href="styles/main.css">',
				`<style>.badge { background: url("${assetPath}?version=1"); }</style>`,
				`<img src="${assetPath}" alt="中性图标 Neutral icon 🌿">`,
				`<img src="./${assetPath}#preview" alt="图标预览 Icon preview 🌿">`,
			].join(''),
			reader: source,
		}
		const assertAsset = (
			result: Awaited<ReturnType<typeof assembleAppContent>>,
			bytes: Uint8Array,
		) => {
			const url = dataUrl('image/svg+xml', bytes)
			expect(result.css.split(url)).toHaveLength(3)
			const images = Array.from(parse(result.html).querySelectorAll('img'))
			expect(images.map((image) => image.getAttribute('src'))).toEqual([
				url,
				url,
			])
		}

		const first = await assembleAppContent(input)
		assertAsset(first, initial)
		expect(reads.filter((path) => path === `binary:${assetPath}`)).toHaveLength(
			1,
		)

		files[assetPath] = updated
		const second = await assembleAppContent(input)
		assertAsset(second, updated)
		expect(reads.filter((path) => path === `binary:${assetPath}`)).toHaveLength(
			2,
		)
		expect(first.html).not.toBe(second.html)
		expect(first.css).not.toBe(second.css)
	})

	it('strips query strings and fragments while leaving fragment and data references untouched', async () => {
		const logo = utf8('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
		const attached = Uint8Array.from([0x47, 0x49, 0x46])
		const { source, reads } = reader({
			'inline.png': attached,
			'assets/logo.svg': logo,
			'app.js': 'const query = "查询 Query 🌿"',
			'styles.css': [
				'.a { background: url(media/dot.png?v=2#frag); }',
				'.b { mask: url("#mask"); }',
				'.c { cursor: url("data:image/png;base64,AAAA"), auto; }',
			].join('\n'),
			'media/dot.png': Uint8Array.from([1, 2, 3]),
		})
		const result = await assembleAppContent({
			html: [
				'<link rel="stylesheet" href="styles.css?v=3">',
				'<img id="logo" src="assets/logo.svg?v=2#frag">',
				'<img id="inline" src="data:image/png;base64,AAAA">',
				'<img id="fragment" src="#local">',
				'<script src="app.js?cache=1"></script>',
			].join(''),
			reader: source,
		})

		const body = parse(result.html)
		expect(body.querySelector('#logo')?.getAttribute('src')).toBe(
			dataUrl('image/svg+xml', logo),
		)
		expect(body.querySelector('#inline')?.getAttribute('src')).toBe(
			'data:image/png;base64,AAAA',
		)
		expect(body.querySelector('#fragment')?.getAttribute('src')).toBe('#local')
		expect(result.css).toContain(
			`url("${dataUrl('image/png', Uint8Array.from([1, 2, 3]))}")`,
		)
		expect(result.css).toContain('url("#mask")')
		expect(result.css).toContain('url("data:image/png;base64,AAAA")')
		expect(reads).toContain('text:app.js')
		expect(reads).not.toContain('text:app.js?cache=1')
		expect(reads).not.toContain('binary:assets/logo.svg?v=2')
	})

	it('inlines image, media and font references as typed data URLs', async () => {
		const poster = utf8('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
		const clip = Uint8Array.from([0, 0, 0, 24])
		const tone = Uint8Array.from([0x49, 0x44, 0x33])
		const font = Uint8Array.from([0x77, 0x4f, 0x46, 0x32])
		const { source } = reader({
			'media/cover.jpg': poster,
			'media/clip.mp4': clip,
			'media/clip.webm': clip,
			'media/tone.mp3': tone,
			'fonts/text.woff2': font,
			'icons/icon.svg': poster,
		})
		const result = await assembleAppContent({
			html: [
				'<video poster="media/cover.jpg">',
				'<source src="media/clip.webm" type="video/webm">',
				'<audio src="media/tone.mp3"></audio>',
				'</video>',
				'<video src="media/clip.mp4"></video>',
				'<svg><image href="icons/icon.svg"></image></svg>',
			].join(''),
			reader: source,
		})

		const body = parse(result.html)
		expect(body.querySelector('video')?.getAttribute('poster')).toBe(
			dataUrl('image/jpeg', poster),
		)
		expect(body.querySelector('source')?.getAttribute('src')).toBe(
			dataUrl('video/webm', clip),
		)
		expect(body.querySelector('audio')?.getAttribute('src')).toBe(
			dataUrl('audio/mpeg', tone),
		)
		expect(body.querySelectorAll('video')[1]?.getAttribute('src')).toBe(
			dataUrl('video/mp4', clip),
		)
		expect(body.querySelector('image')?.getAttribute('href')).toBe(
			dataUrl('image/svg+xml', poster),
		)
	})
	it('inlines font and image urls declared in CSS', async () => {
		const font = Uint8Array.from([0x00, 0x01, 0x00, 0x00, 0x4f])
		const dot = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
		const { source } = reader({
			'fonts/text.woff2': font,
			'images/dot.png': dot,
		})
		const result = await assembleAppContent({
			html: `<style>
				@font-face { font-family: Neutral; src: url(" fonts/text.woff2 "); }
				body { background-image: URL(images/dot.png); }
			</style>`,
			reader: source,
		})

		expect(result.css).toContain(`url("${dataUrl('font/woff2', font)}")`)
		expect(result.css).toContain(`url("${dataUrl('image/png', dot)}")`)
	})

	it.each([
		[
			'remote URL in a stylesheet link',
			{
				'index.html':
					'<link rel="stylesheet" href="https://example.test/styles.css">',
			},
			'index.html',
			/Remote URL is not supported/,
		],
		[
			'remote URL in a script source',
			{ 'index.html': '<script src="https://example.test/app.js"></script>' },
			'index.html',
			/Remote URL is not supported/,
		],
		[
			'protocol-relative image source',
			{ 'index.html': '<img src="//cdn.example.test/logo.png">' },
			'index.html',
			/Protocol-relative URL is not supported/,
		],
		[
			'absolute image source',
			{ 'index.html': '<img src="/assets/logo.png">' },
			'index.html',
			/Absolute path is not supported/,
		],
		[
			'absolute CSS url',
			{
				'index.html': '<link rel="stylesheet" href="styles.css">',
				'styles.css': 'body { background: url(/assets/bg.png); }',
			},
			'styles.css',
			/Absolute path is not supported/,
		],
		[
			'remote CSS import',
			{
				'index.html': '<link rel="stylesheet" href="styles.css">',
				'styles.css': '@import "https://example.test/base.css";',
			},
			'styles.css',
			/Remote URL is not supported/,
		],
		[
			'remote stylesheet with a query string',
			{
				'index.html':
					'<link rel="stylesheet" href="https://example.test/styles.css?v=1">',
			},
			'index.html',
			/Remote URL is not supported/,
		],
	])('rejects %s', async (_name, files, path, message) => {
		const { source } = reader(files)
		const error = await sourceError(
			assembleAppContent({ html: files['index.html'] ?? '', reader: source }),
		)
		expect(error.path).toBe(path)
		expect(error.message).toMatch(message)
	})

	it.each([
		[
			'traversing image source',
			{ 'index.html': '<img src="../outside.png">' },
			'index.html',
		],
		[
			'traversing CSS import',
			{
				'index.html': '<link rel="stylesheet" href="styles.css">',
				'styles.css': '@import "../outside.css";',
			},
			'styles.css',
		],
		[
			'traversing nested CSS url',
			{
				'index.html': '<link rel="stylesheet" href="styles/main.css">',
				'styles/main.css': 'body { background: url("../../outside.png"); }',
			},
			'styles/main.css',
		],
		[
			'directory reference',
			{ 'index.html': '<img src="assets/">' },
			'index.html',
		],
	])('rejects %s', async (_name, files, path) => {
		const { source } = reader(files)
		const error = await sourceError(
			assembleAppContent({ html: files['index.html'] ?? '', reader: source }),
		)
		expect(error.path).toBe(path)
		expect(error.message).toMatch(/escapes the App directory|must name a file/)
	})

	it('rejects srcset, base elements and unsupported script flavours', async () => {
		const imageSrcset = await sourceError(
			assembleAppContent({
				html: '<img src="logo.png" srcset="logo.png 1x">',
				reader: reader({}).source,
			}),
		)
		expect(imageSrcset.path).toBe('index.html')
		expect(imageSrcset.message).toMatch(/srcset is not supported/)
		const srcset = await sourceError(
			assembleAppContent({
				html: '<source src="clip.webm" srcset="clip.webm 1x">',
				reader: reader({}).source,
			}),
		)
		expect(srcset.message).toMatch(/srcset is not supported/)

		const base = await sourceError(
			assembleAppContent({
				html: '<base href="/"><p>中性 Neutral 🌿</p>',
				reader: reader({}).source,
			}),
		)
		expect(base.message).toMatch(/<base> is not supported/)

		const moduleScript = await sourceError(
			assembleAppContent({
				html: '<script type="module" src="app.js"></script>',
				reader: reader({ 'app.js': 'export {}' }).source,
			}),
		)
		expect(moduleScript.path).toBe('index.html')
		expect(moduleScript.message).toMatch(/ES module scripts are not supported/)

		const templateScript = await sourceError(
			assembleAppContent({
				html: '<script type="text/template">中性模板 Neutral template 🌿</script>',
				reader: reader({}).source,
			}),
		)
		expect(templateScript.message).toMatch(/Unsupported script type/)

		const classic = await assembleAppContent({
			html: '<script type=" text/javascript ">const neutral = 1</script>',
			reader: reader({}).source,
		})
		expect(classic.javascript).toBe('const neutral = 1')
	})

	it('detects circular and self-referencing CSS imports', async () => {
		const circular = await sourceError(
			assembleAppContent({
				html: '<link rel="stylesheet" href="a.css">',
				reader: reader({
					'a.css': '@import "b.css";\n.a { color: green; }',
					'b.css': '@import "a.css";\n.b { color: red; }',
				}).source,
			}),
		)
		expect(circular.message).toMatch(/Circular CSS @import/)
		expect(circular.path).toBe('a.css')

		const self = await sourceError(
			assembleAppContent({
				html: '<link rel="stylesheet" href="self.css">',
				reader: reader({
					'self.css': '@import "self.css";',
				}).source,
			}),
		)
		expect(self.message).toMatch(/Circular CSS @import: self\.css -> self\.css/)
	})

	it('rejects unsupported asset types and unreadable files', async () => {
		const unsupported = await sourceError(
			assembleAppContent({
				html: '<link rel="stylesheet" href="styles.css">',
				reader: reader({
					'styles.css': 'body { background: url(notes.txt); }',
					'notes.txt': utf8('中性文本 Neutral text 🌿'),
				}).source,
			}),
		)
		expect(unsupported.path).toBe('notes.txt')
		expect(unsupported.message).toMatch(/Unsupported App asset type/)

		// Reading still precedes type validation, so missing unsupported files
		// retain the actionable I/O failure in both CSS and markup.
		for (const html of [
			'<style>.icon { background: url("中性 Neutral 🌿.txt"); }</style>',
			'<img src="中性 Neutral 🌿.txt" alt="中性图标 Neutral icon 🌿">',
		]) {
			const missingUnsupported = await sourceError(
				assembleAppContent({ html, reader: reader({}).source }),
			)
			expect(missingUnsupported.path).toBe('中性 Neutral 🌿.txt')
			expect(missingUnsupported.message).toMatch(/Cannot read App asset/)
		}

		const missingAsset = await sourceError(
			assembleAppContent({
				html: '<img src="missing.png">',
				reader: reader({}).source,
			}),
		)
		expect(missingAsset.path).toBe('missing.png')
		expect(missingAsset.message).toMatch(/Cannot read App asset/)

		const missingText = await sourceError(
			assembleAppContent({
				html: '<script src="missing.js"></script>',
				reader: reader({}).source,
			}),
		)
		expect(missingText.path).toBe('missing.js')
		expect(missingText.message).toMatch(/Cannot read App file/)
	})

	it('removes host-owned markup and preserves inert authored content', async () => {
		const result = await assembleAppContent({
			html: [
				'<body>',
				'<link rel="preload" href="https://example.test/preload.png" as="image">',
				'<link rel="icon" href="data:image/png;base64,AAAA">',
				'<!-- 中性注释 Neutral comment 🌿 -->',
				'<p>中性内容 Neutral content 🌿</p>',
				'</body>',
			].join(''),
			reader: reader({}).source,
		})
		const body = parse(result.html)
		expect(body.querySelectorAll('link')).toHaveLength(0)
		expect(body.querySelector('p')?.textContent).toBe(
			'中性内容 Neutral content 🌿',
		)
		expect(result.html).toContain('中性注释 Neutral comment 🌿')
	})

	it('does not resolve url-like text inside CSS comments or strings', async () => {
		const css = [
			'/* url(images/missing.png) */',
			'.a { content: "url(images/missing.png)"; }',
			'.b { background: url("#gradient"); }',
		].join('\n')
		const { source, reads } = reader({})
		const result = await assembleAppContent({
			html: `<style>${css}</style>`,
			reader: source,
		})
		expect(result.css).toBe(css)
		expect(reads).toEqual([])
	})

	it('handles quoted, single-quoted and URL-wrapped CSS imports in authored order', async () => {
		const { source } = reader({
			'base.css': '.base { color: green; }',
			'tokens.css': ':root { --tone: red; }',
			'extra.css': '.extra { color: cyan; }',
			'main.css': [
				'@import url("base.css");',
				"@import 'tokens.css';",
				'@IMPORT url(extra.css);',
				'.main { color: blue; }',
			].join('\n'),
		})
		const result = await assembleAppContent({
			html: [
				'<link rel="stylesheet" href="main.css">',
				'<style>.inline { color: black; }</style>',
			].join(''),
			reader: source,
		})
		const order = ['.base', ':root', '.extra', '.main', '.inline'].map(
			(selector) => result.css.indexOf(selector),
		)
		for (const index of order) expect(index).toBeGreaterThanOrEqual(0)
		expect([...order].sort((left, right) => left - right)).toEqual(order)
		expect(result.css).not.toContain('@import')
	})

	it('rejects CSS imports with media conditions or unterminated values', async () => {
		const media = await sourceError(
			assembleAppContent({
				html: '<link rel="stylesheet" href="styles.css">',
				reader: reader({
					'styles.css': '@import "print.css" print;',
				}).source,
			}),
		)
		expect(media.message).toMatch(/media conditions is not supported/)

		const dangling = await sourceError(
			assembleAppContent({
				html: '<link rel="stylesheet" href="styles.css">',
				reader: reader({ 'styles.css': '.a { background: url("x.png" }' })
					.source,
			}),
		)
		expect(dangling.message).toMatch(/Unterminated url\(\)/)
	})

	it('returns empty assembled content for an empty document', async () => {
		expect(
			await assembleAppContent({ html: '', reader: reader({}).source }),
		).toEqual({ html: '', css: '', javascript: '' })
	})
})
