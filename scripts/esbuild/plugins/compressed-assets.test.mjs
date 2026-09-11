import { build, context } from 'esbuild'
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { compressedAssetsPlugin } from './compressed-assets.mjs'

const directories = []
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((dir) => rm(dir, { recursive: true, force: true })),
	)
})

async function fixture(contents, prod = true) {
	const dir = await realpath(
		await mkdtemp(path.join(tmpdir(), 'compressed-assets-')),
	)
	directories.push(dir)
	return {
		dir,
		options: {
			stdin: { contents, resolveDir: dir },
			bundle: true,
			write: false,
			platform: 'browser',
			format: 'iife',
			globalName: 'assets',
			minify: true,
			metafile: true,
			plugins: [compressedAssetsPlugin({ prod, sourceRoot: dir })],
		},
	}
}

function evaluate(result) {
	// Deliberately omit Node globals, TextDecoder and atob, as on older WebViews.
	const sandbox = { exports: {}, Uint8Array, Uint16Array, Int32Array }
	vm.runInNewContext(result.outputFiles[0].text, sandbox)
	return sandbox.assets
}

const text = 'Notes 笔记 🌿 — café\r\n\t"quoted" \\ path\0\n'.repeat(500)

describe('compressed assets', () => {
	it.each([true, false])(
		'preserves raw text and JSON exports in production=%s',
		async (prod) => {
			const { dir, options } = await fixture(
				`
			import raw from './notes.md?raw';
			import data, { title, 中文, null as empty } from './data.json';
			import again from './data.json';
			export { raw, data, title, 中文, empty };
			export const same = data === again && title === data.title;
		`,
				prod,
			)
			const value = {
				title: { text },
				中文: text,
				null: null,
				default: 'Hello 你好 🌿',
				list: [false, 0, '\ud800'],
			}
			await writeFile(path.join(dir, 'notes.md'), text)
			await writeFile(path.join(dir, 'data.json'), JSON.stringify(value))
			const result = await build(options)
			const output = evaluate(result)
			expect(output.raw).toBe(text)
			expect(output.data).toEqual(value)
			expect(output.title).toEqual(value.title)
			expect(output.中文).toBe(text)
			expect(output.empty).toBeNull()
			expect(output.same).toBe(true)
			if (prod)
				expect(result.outputFiles[0].contents.length).toBeLessThan(text.length)
		},
	)

	it('keeps small assets native and removes unused compressed assets', async () => {
		const { dir, options } = await fixture(`
			import unused from './notes.md?raw';
			import tiny from './icon.svg?raw';
			import data from './data.json';
			export { tiny, data };
		`)
		const tiny = '<svg>Hello 你好 🌿</svg>'
		await writeFile(path.join(dir, 'notes.md'), text)
		await writeFile(path.join(dir, 'icon.svg'), tiny)
		await writeFile(
			path.join(dir, 'data.json'),
			JSON.stringify({ title: 'Hello 你好 🌿' }),
		)
		const result = await build(options)
		expect(evaluate(result)).toEqual({ tiny, data: { title: 'Hello 你好 🌿' } })
		expect(result.outputFiles[0].text).not.toContain('atob')
	})

	it('reloads changed assets and rejects malformed JSON', async () => {
		const { dir, options } = await fixture(
			`import data from './data.json'; export default data;`,
		)
		const filename = path.join(dir, 'data.json')
		await writeFile(filename, JSON.stringify({ text }))
		const builder = await context({ ...options, logLevel: 'silent' })
		try {
			expect(evaluate(await builder.rebuild()).default).toEqual({ text })
			await writeFile(
				filename,
				JSON.stringify({ text: text + 'Updated 更新 🌱' }),
			)
			expect(evaluate(await builder.rebuild()).default).toEqual({
				text: text + 'Updated 更新 🌱',
			})
			await writeFile(filename, '{"title": "Hello 你好 🌿",}')
			await expect(builder.rebuild()).rejects.toThrow()
		} finally {
			await builder.dispose()
		}
	})
})
