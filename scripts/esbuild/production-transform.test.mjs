import { transform } from '@swc/core'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { injectSourcePolyfills } from './plugins/source-polyfills.mjs'

const configFile = fileURLToPath(new URL('../../.swcrc', import.meta.url))

describe('production SWC transform', () => {
	it('preserves async, inheritance and public properties through compression', async () => {
		const source = `
			class Note {
				#title;
				constructor(title) { this.#title = title; }
				get title() { return this.#title; }
			}
			class Entry extends Note {
				async *lines() { yield await Promise.resolve(this.title); }
			}
			module.exports = async (title) => {
				const entry = new Entry(title);
				const lines = [];
				for await (const line of entry.lines()) lines.push(line);
				const metadata = { ...{ title }, lines, missing: null };
				return { ...metadata, fallback: metadata.missing?.title ?? title };
			};
		`
		const { code } = await transform(source, { configFile })
		const sandbox = { module: { exports: undefined } }
		vm.runInNewContext(code, sandbox)
		const title = 'Notes 笔记 🌿 café'
		expect(await sandbox.module.exports(title)).toEqual({
			title,
			lines: [title],
			missing: null,
			fallback: title,
		})
		// These constructs are newer than the configured Chrome/iOS baseline.
		expect(code).not.toMatch(/#title|\?\.|\?\?/)
	})

	it('keeps selected polyfills executable without Node APIs after optimization', async () => {
		const { source, modules } = await injectSourcePolyfills(
			`module.exports = (values) => {
				const { promise, resolve } = Promise.withResolvers();
				resolve(values.toSorted());
				return promise;
			};`,
			{ prod: true },
		)
		expect(modules).toContain('core-js/modules/es.promise.with-resolvers.js')
		expect(modules).toContain('core-js/modules/es.array.to-sorted.js')
		const { code } = await transform(source, { configFile })
		const sandbox = vm.createContext({ module: { exports: undefined } })
		vm.runInContext(
			'Promise.withResolvers = undefined; Array.prototype.toSorted = undefined;',
			sandbox,
		)
		vm.runInContext(code, sandbox)
		const result = await vm.runInContext(
			`module.exports(['🌿', '笔记', 'Notes'])`,
			sandbox,
		)
		expect(result).toEqual(['Notes', '笔记', '🌿'])
	})
})
