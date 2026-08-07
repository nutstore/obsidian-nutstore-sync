import dotenv from 'dotenv'
import esbuild from 'esbuild'
import fs, { readFileSync } from 'fs'
import jiti from 'jiti'
import path from 'path'
import postcss from 'postcss'
import postcssMergeRules from 'postcss-merge-rules'
import process from 'process'
import { createGenerator } from 'unocss'
import solid from 'unplugin-solid/esbuild'

const pkgJson = JSON.parse(readFileSync('./package.json', 'utf-8'))
dotenv.config()

const prod = process.argv[2] === 'production'
process.env.NODE_ENV = prod ? 'production' : 'development'
const loadConfig = jiti(import.meta.url, { moduleCache: false })

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

async function createUnoGenerator() {
	const config = await loadConfig.import('./uno.config.ts', { default: true })
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

const rawTextPlugin = {
	name: 'raw-text',
	setup(build) {
		build.onResolve({ filter: /\.md\?raw$/ }, (args) => ({
			path: path.resolve(args.resolveDir, args.path.slice(0, -4)),
			namespace: 'raw-text',
		}))
		build.onLoad({ filter: /.*/, namespace: 'raw-text' }, async (args) => ({
			contents: await fs.promises.readFile(args.path, 'utf8'),
			loader: 'text',
			watchFiles: [args.path],
		}))
	},
}

const postcssPlugin = {
	name: 'postcss',
	setup(build) {
		build.onResolve({ filter: /\.css$/ }, (args) => ({
			path: path.resolve(args.resolveDir, args.path),
			namespace: 'postcss',
			pluginData: {
				resolveDir: args.resolveDir || process.cwd(),
				importer: args.importer,
			},
		}))

		build.onLoad({ filter: /\.css$/, namespace: 'postcss' }, async (args) => {
			const resolvedPath = args.path
			const css = await fs.promises.readFile(resolvedPath, 'utf8')
			return {
				contents: css,
				loader: 'css',
				watchFiles: [resolvedPath, './uno.config.ts'],
				resolveDir: args.pluginData?.resolveDir,
			}
		})
	},
}

const renamePlugin = {
	name: 'rename-plugin',
	setup(build) {
		build.onEnd(async (result) => {
			if (result.errors.length > 0) {
				return
			}

			const source = prod ? './dist/main.css' : './main.css'
			if (fs.existsSync(source)) {
				fs.renameSync(source, './styles.css')
			}
		})
	},
}

const finalizeUnoPlugin = {
	name: 'finalize-unocss',
	setup(build) {
		build.onEnd(async (result) => {
			if (result.errors.length > 0) return

			const uno = await createUnoGenerator()
			const tokens = new Set()
			const jsPath = prod ? './dist/main.js' : './main.js'
			const cssPath = './styles.css'
			const [js, css] = await Promise.all([
				fs.promises.readFile(jsPath, 'utf8'),
				fs.promises.readFile(cssPath, 'utf8'),
			])
			const transformedJs = await transformUnoClasses(js, uno, tokens)
			const generatedCss = (await uno.generate(prod ? tokens : js)).css
			const transformedCss = await postcss([postcssMergeRules()]).process(
				css.replace('@unocss;', generatedCss),
				{ from: cssPath },
			)

			await Promise.all([
				fs.promises.writeFile(jsPath, transformedJs),
				fs.promises.writeFile(cssPath, transformedCss.css),
			])
		})
	},
}

const buildOptions = {
	entryPoints: ['src/index.ts'],
	bundle: true,
	external: [
		'obsidian',
		'electron',
		'@codemirror/autocomplete',
		'@codemirror/collab',
		'@codemirror/commands',
		'@codemirror/language',
		'@codemirror/lint',
		'@codemirror/search',
		'@codemirror/state',
		'@codemirror/view',
		'@lezer/common',
		'@lezer/highlight',
		'@lezer/lr',
	],
	define: {
		'process.env.NS_NSDAV_ENDPOINT': JSON.stringify(
			process.env.NS_NSDAV_ENDPOINT,
		),
		'process.env.NS_DAV_ENDPOINT': JSON.stringify(process.env.NS_DAV_ENDPOINT),
		'process.env.LLM_GATEWAY_CLIENT_ID': JSON.stringify(
			process.env.LLM_GATEWAY_CLIENT_ID || '',
		),
		'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || ''),
		'process.env.PLUGIN_VERSION': JSON.stringify(pkgJson.version),
	},
	format: 'cjs',
	target: 'es2018',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	outfile: prod ? 'dist/main.js' : 'main.js',
	minify: prod,
	platform: 'browser',
	plugins: [
		rawTextPlugin,
		postcssPlugin,
		solid(),
		renamePlugin,
		finalizeUnoPlugin,
	],
	alias: {
		'node:zlib': './src/shims/node-zlib.ts',
	},
}

if (prod) {
	await esbuild.build(buildOptions)
} else {
	const context = await esbuild.context(buildOptions)
	await context.watch()
}
