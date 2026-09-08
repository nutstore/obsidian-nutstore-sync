import fs from 'node:fs'
import jiti from 'jiti'
import path from 'node:path'
import postcss from 'postcss'
import postcssMergeRules from 'postcss-merge-rules'
import { createGenerator } from 'unocss'
import { removeInlineSourceMap } from './output-source.mjs'

class TransformableSource {
	constructor(source) {
		this.original = source
		this.replacements = []
	}

	overwrite(start, end, content) {
		this.replacements.push({ start, end, content })
	}

	toString() {
		return this.replacements
			.sort((first, second) => second.start - first.start)
			.reduce(
				(source, replacement) =>
					source.slice(0, replacement.start) +
					replacement.content +
					source.slice(replacement.end),
				this.original,
			)
	}
}

const loadConfig = jiti(import.meta.url, { moduleCache: false })

async function createUnoGenerator() {
	const config = await loadConfig.import('../../../uno.config.ts', {
		default: true,
	})
	return createGenerator(config)
}

async function transformUnoClasses(source, uno, tokens) {
	if (!source.includes(':uno:')) return source

	const transformed = new TransformableSource(source)
	for (const transformer of uno.config.transformers) {
		await transformer.transform(transformed, '', {
			uno,
			tokens,
			invalidate: () => {},
		})
	}
	return transformed.toString()
}

export async function readDevelopmentUnoSource(metafile) {
	const sourceRoot = path.resolve('src')
	const sourcePaths = new Set(
		Object.keys(metafile?.inputs ?? {})
			.map((inputPath) => path.resolve(inputPath))
			.filter(
				(inputPath) =>
					inputPath === sourceRoot ||
					inputPath.startsWith(`${sourceRoot}${path.sep}`),
			),
	)

	if (sourcePaths.size === 0) return undefined

	return (
		await Promise.all(
			Array.from(sourcePaths, (sourcePath) =>
				fs.promises.readFile(sourcePath, 'utf8'),
			),
		)
	).join('\n')
}

export async function finalizeUnoCss({ js, css, prod, cssPath, scanSource }) {
	const uno = await createUnoGenerator()
	const tokens = new Set()
	const transformedJs = await transformUnoClasses(js, uno, tokens)
	const generatedCss = (
		await uno.generate(prod ? tokens : removeInlineSourceMap(scanSource ?? js))
	).css
	const transformedCss = await postcss([postcssMergeRules()]).process(
		css.replace('@unocss;', generatedCss),
		{ from: cssPath },
	)

	return {
		js: transformedJs,
		css: transformedCss.css,
	}
}
