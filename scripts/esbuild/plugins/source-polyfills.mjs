import { transform } from '@swc/core'
import esbuild from 'esbuild'
import { createRequire } from 'node:module'
import process from 'node:process'
import { removeInlineSourceMap } from './output-source.mjs'

const require = createRequire(import.meta.url)
const coreJsVersion = require('core-js/package.json').version
const coreJsCompatVersion = coreJsVersion.split('.').slice(0, 2).join('.')

export const OBSIDIAN_RUNTIME_TARGETS = {
	chrome: '69',
	electron: '30',
	ios: '12',
}

const CORE_JS_MODULE_PATTERN =
	/(?:import\s+["']|require\(["'])(core-js\/modules\/[^"']+\.js)/g

const coreJsBundleCache = new Map()

/**
 * Let SWC's usage transform decide which core-js modules are required by the
 * code that will actually ship. SWC expresses that decision as side-effect
 * imports; we only read those generated imports so esbuild can bundle them
 * into Obsidian's single-file plugin output.
 */
export async function detectCoreJsPolyfills(source) {
	const transformed = await transform(removeInlineSourceMap(source), {
		jsc: {
			parser: { syntax: 'ecmascript' },
		},
		env: {
			mode: 'usage',
			coreJs: coreJsCompatVersion,
			targets: OBSIDIAN_RUNTIME_TARGETS,
			// src/polyfill.ts owns this compatibility boundary so core-js does not
			// bundle its legacy dynamic-script scheduler fallback.
			exclude: ['web.queue-microtask'],
		},
		module: { type: 'es6' },
	})
	return Array.from(
		new Set(
			Array.from(
				transformed.code.matchAll(CORE_JS_MODULE_PATTERN),
				(match) => match[1],
			),
		),
	).sort()
}

async function buildCoreJsPolyfills(modules, prod) {
	const cacheKey = `${prod ? 'production' : 'development'}:${modules.join('\0')}`
	const cached = coreJsBundleCache.get(cacheKey)
	if (cached) return cached

	const buildPromise = esbuild
		.build({
			stdin: {
				contents: modules.map((module) => `import '${module}'`).join('\n'),
				resolveDir: process.cwd(),
				sourcefile: 'generated-core-js-entry.js',
			},
			bundle: true,
			format: 'iife',
			logLevel: 'silent',
			minify: prod,
			platform: 'browser',
			target: 'es2018',
			write: false,
		})
		.then((result) => {
			const polyfillSource = result.outputFiles[0]?.text
			if (!polyfillSource) {
				throw new Error('Failed to build detected core-js polyfills.')
			}
			return polyfillSource
		})

	coreJsBundleCache.set(cacheKey, buildPromise)
	try {
		return await buildPromise
	} catch (error) {
		coreJsBundleCache.delete(cacheKey)
		throw error
	}
}

export async function injectSourcePolyfills(source, { prod }) {
	const modules = await detectCoreJsPolyfills(source)
	if (modules.length === 0) return { source, modules }

	const polyfillSource = await buildCoreJsPolyfills(modules, prod)
	return {
		source: `/* Source-selected core-js polyfills: ${modules.join(', ')} */\n${polyfillSource}\n${source}`,
		modules,
	}
}
