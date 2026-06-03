import UnoCSS from '@unocss/postcss'
import dotenv from 'dotenv'
import esbuild from 'esbuild'
import fs, { readFileSync } from 'fs'
import path from 'path'
import postcss from 'postcss'
import postcssMergeRules from 'postcss-merge-rules'
import process from 'process'
import solid from 'unplugin-solid/esbuild'

const pkgJson = JSON.parse(readFileSync('./package.json', 'utf-8'))
dotenv.config()

const prod = process.argv[2] === 'production'

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
			const result = await postcss([UnoCSS(), postcssMergeRules()]).process(
				css,
				{ from: resolvedPath },
			)
			const watchFiles = result.messages
				.filter((m) => m.type === 'dependency')
				.map((m) => m.file)
			return {
				contents: result.css,
				loader: 'css',
				watchFiles: [resolvedPath, ...watchFiles],
				resolveDir: args.pluginData?.resolveDir,
			}
		})
	},
}

const renamePlugin = {
	name: 'rename-plugin',
	setup(build) {
		build.onEnd(async () => {
			const source = prod ? './dist/main.css' : './main.css'
			if (fs.existsSync(source)) {
				fs.renameSync(source, './styles.css')
			}
		})
	},
}

const context = await esbuild.context({
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
	plugins: [postcssPlugin, solid(), renamePlugin],
	alias: {
		'node:zlib': './src/shims/node-zlib.ts',
	},
})

if (prod) {
	await context.rebuild()
	process.exit(0)
} else {
	await context.watch()
}
