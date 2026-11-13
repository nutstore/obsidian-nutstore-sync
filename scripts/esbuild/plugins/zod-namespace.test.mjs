import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
	rewriteZodNamespaceImports,
	zodNamespaceImportPlugin,
} from './zod-namespace.mjs'

describe('rewriteZodNamespaceImports', () => {
	it.each([
		[`import { z } from 'zod/mini'`, `import * as z from 'zod/mini'`],
		[`import { z as shape } from "zod/v4"`, `import * as shape from "zod/v4"`],
		[`import {z} from 'zod'`, `import * as z from 'zod'`],
	])('rewrites %s', (source, expected) => {
		expect(rewriteZodNamespaceImports(source)).toBe(expected)
	})

	it('leaves unrelated imports and multilingual content intact', () => {
		const source = [
			`import { z as z2 } from 'other-zod'`,
			`import * as z from 'zod/mini'`,
			`const label = '示例 Example 🌿'`,
			`export { z, z2, label }`,
		].join('\n')
		expect(rewriteZodNamespaceImports(source)).toBe(source)
	})

	it('preserves imports with other named bindings for the build guard', () => {
		const source = `import { z, ZodType } from 'zod/v4'`
		expect(rewriteZodNamespaceImports(source)).toBe(source)
	})
})

describe('zodNamespaceImportPlugin', () => {
	it('tree-shakes zod locales from AI SDK providers', async () => {
		const root = fileURLToPath(new URL('../../..', import.meta.url))
		const result = await build({
			stdin: {
				contents: `export { createOpenAI } from '@ai-sdk/openai'`,
				resolveDir: root,
			},
			bundle: true,
			write: false,
			minify: true,
			platform: 'node',
			format: 'esm',
			metafile: true,
			plugins: [zodNamespaceImportPlugin()],
		})
		const output = Object.values(result.metafile.outputs)[0]
		const locales = Object.keys(output.inputs).filter((input) =>
			input.includes('zod/v4/locales'),
		)
		expect(locales).toHaveLength(1)
		expect(locales[0]).toMatch(/zod\/v4\/locales\/en\.js$/)
	})
})
