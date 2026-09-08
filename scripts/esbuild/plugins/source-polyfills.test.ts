import { describe, expect, it } from 'vitest'
import { detectCoreJsPolyfills } from './source-polyfills.mjs'

describe('source polyfill detection', () => {
	it('selects only APIs missing from supported Obsidian runtimes', async () => {
		const modules = await detectCoreJsPolyfills(
			`const neutral = 'Hello 你好 🌿';
			Promise.resolve(neutral);
			Promise.withResolvers();
			queueMicrotask(() => neutral);
			[neutral].toSorted();`,
		)

		expect(modules).toEqual([
			'core-js/modules/es.array.sort.js',
			'core-js/modules/es.array.to-sorted.js',
			'core-js/modules/es.promise.with-resolvers.js',
		])
	})
})
