import postcss from '@deanc/esbuild-plugin-postcss'
import UnoCSS from '@unocss/postcss'
import dotenv from 'dotenv'
import esbuild from 'esbuild'
import fs from 'fs'
import postcssMergeRules from 'postcss-merge-rules'
import process from 'process'

const renamePlugin = {
	name: 'rename-plugin',
	setup(build) {
		build.onEnd(async () => {
			fs.renameSync('./main.css', './styles.css')
		})
	},
}

dotenv.config()

const prod = process.argv[2] === 'production'

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
		'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || ''),
	},
	format: 'cjs',
	target: 'es2015',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	outfile: 'main.js',
	minify: prod,
	platform: 'browser',
	plugins: [
		postcss({
			plugins: [UnoCSS(), postcssMergeRules()],
		}),
		renamePlugin,
	],
})

if (prod) {
	await context.rebuild()
	process.exit(0)
} else {
	await context.watch()
}
