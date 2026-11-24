import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { mcpValidatorShimPlugin } from './mcp-validator-shim.mjs'

const root = fileURLToPath(new URL('../../..', import.meta.url))

describe('mcpValidatorShimPlugin', () => {
	it('replaces ajv with @cfworker/json-schema and validates schemas', async () => {
		const result = await build({
			stdin: {
				contents: `
					import { Client } from '@modelcontextprotocol/sdk/client/index.js'
					import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
					export { Client, AjvJsonSchemaValidator }
				`,
				resolveDir: root,
			},
			bundle: true,
			write: false,
			minify: true,
			platform: 'browser',
			format: 'cjs',
			metafile: true,
			plugins: [mcpValidatorShimPlugin()],
		})

		const inputs = Object.keys(Object.values(result.metafile.outputs)[0].inputs)
		expect(inputs.some((file) => file.includes('/ajv/'))).toBe(false)
		expect(inputs.some((file) => file.includes('/ajv-formats/'))).toBe(false)
		expect(inputs.some((file) => file.includes('/fast-uri/'))).toBe(false)
		expect(inputs.some((file) => file.includes('@cfworker/json-schema'))).toBe(
			true,
		)

		const sandbox = {
			module: { exports: {} },
			exports: {},
			URL,
			URLSearchParams,
			TextEncoder,
			TextDecoder,
			ReadableStream,
			WritableStream,
			TransformStream,
			console,
			setTimeout,
			clearTimeout,
			crypto: globalThis.crypto,
		}
		vm.runInNewContext(result.outputFiles[0].text, sandbox)
		const { AjvJsonSchemaValidator } = sandbox.module.exports
		const validate = new AjvJsonSchemaValidator().getValidator({
			type: 'object',
			properties: { title: { type: 'string', minLength: 1 } },
			required: ['title'],
			additionalProperties: false,
		})

		expect(validate({ title: 'Notes 笔记 🌿' })).toEqual({
			valid: true,
			data: { title: 'Notes 笔记 🌿' },
			errorMessage: undefined,
		})
		expect(validate({ title: '' }).valid).toBe(false)
		expect(validate({ title: 'Notes 笔记 🌿', extra: true }).valid).toBe(false)
	})
})
